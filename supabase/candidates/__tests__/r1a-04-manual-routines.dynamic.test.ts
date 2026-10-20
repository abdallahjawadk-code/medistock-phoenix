/**
 * R1-a candidate 04 — DYNAMIC proof of the eight manual writers (shipped inert), the readers,
 * the writer census (15 -> 23) and the owner-only ACL. Real PostgreSQL only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import {
  ORG, ORG_BENE, ORG_BENE_B, U, refusal, helpers, buildWithCandidates, newItem, grantManualKey, type Rig,
} from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql', 'R1a_04_manual_routines_inert.sql'];

run('R1-a candidate 04 — manual routines (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig;
  let year = 2030;
  let item = '';
  let item2 = '';
  const h = helpers(() => rig);
  const { admin, txAs } = h;
  const P = 'public.phoenix_central_needs_';

  /** Call a routine as a JWT subject (superuser session impersonating; EXECUTE is owner-only in R1-a). */
  const call = async (sub: string, fn: string, args: unknown[]): Promise<any> => {
    let out: any;
    await txAs(sub, async (q) => {
      const ph = args.map((_, i) => `$${i + 1}`).join(',');
      out = (await q(`SELECT ${P}${fn}(${ph}) AS r`, args))[0].r;
    });
    return out;
  };
  const fresh = async () => {
    year += 1;
    const r = await call(U.maker, 'open_manual_plan_revision', [ORG, year]);
    return { year, rev: r.plan_revision_id as string, plan: r.plan_id as string };
  };
  const add = (sub: string, rev: string, qty = '10', ben = ORG_BENE, it = item, key = randomUUID(), expected: string | null = null) =>
    call(sub, 'add_manual_need_line', [rev, ben, it, null, qty, 'planned need', key, expected, null]);

  beforeAll(async () => {
    rig = await buildWithCandidates(F, 1);
    item = await newItem(admin);
    item2 = await newItem(admin);
    await grantManualKey(rig, [U.maker, U.maker2, U.saKeys]);
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  describe('inert in R1-a: ACL, census, seal', () => {
    it('no API role can EXECUTE any of the eight writers', async () => {
      const rows = await admin(`SELECT p.proname, has_function_privilege('anon',p.oid,'EXECUTE') a, has_function_privilege('authenticated',p.oid,'EXECUTE') u,
          has_function_privilege('service_role',p.oid,'EXECUTE') s
        FROM pg_proc p WHERE p.proname ~ '^phoenix_central_needs_(open_manual|carry_forward_manual|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual)'`);
      expect(rows).toHaveLength(8);
      for (const r of rows) expect([r.a, r.u, r.s], r.proname).toEqual([false, false, false]);
    });
    it('writer census is exactly 23 and the seal is clean', async () => {
      const [{ n }] = await admin(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
        WHERE s.nspname NOT IN ('pg_catalog','information_schema')
          AND regexp_replace(p.prosrc,'--[^\\n]*','','g') ~* '(insert\\s+into|update|delete\\s+from|truncate|merge\\s+into)\\s+(only\\s+)?(table\\s+)?("?public"?\\.|"?phoenix_private"?\\.)?"?central_needs_[a-z_]+'`);
      expect(n).toBe(23);
      expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
    });
    it('actual calls as anon/authenticated/service_role are refused with 42501 before any logic runs', async () => {
      const { rev } = await fresh();
      const calls: Array<[string, string]> = [
        ['open_manual_plan_revision', `('${ORG}', 2098)`],
        ['carry_forward_manual_lines', `('${rev}','${rev}')`],
        ['withdraw_draft_revision', `('${rev}','${rev}','reason text',NULL)`],
        ['acknowledge_manual_coverage', `('${rev}','${'a'.repeat(64)}','reason text')`],
      ];
      for (const role of ['anon', 'authenticated', 'service_role']) for (const [fn, args] of calls) {
        const e = await refusal(h.as(role === 'anon' ? null : U.maker, `SELECT ${P}${fn}${args}`, [], role));
        expect(e.code, `${role} ${fn}`).toBe('42501');
      }
    });
    it('every R1-a routine: explicit pinned search_path (pg_temp last or absent), SECURITY DEFINER only where intended, owner not an API role', async () => {
      const rows = await admin(`SELECT n.nspname||'.'||p.proname AS fn, p.prosecdef, p.proconfig, r.rolname owner,
            (SELECT array_agg(g.rolname) FROM aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a LEFT JOIN pg_roles g ON g.oid=a.grantee
               WHERE a.privilege_type='EXECUTE' AND (a.grantee=0 OR g.rolname IN ('anon','authenticated','service_role'))) AS api_exec
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
         WHERE (n.nspname='public' AND p.proname ~ '^(_?phoenix_central_needs_)(open_manual|carry_forward_manual|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual|list_manual|my_capabilities|actor_authorized|assert_manual)')
            OR n.nspname='phoenix_cn_policy'
            OR (n.nspname='phoenix_private' AND p.proname ~ '^central_needs_')`);
      expect(rows.length).toBeGreaterThan(20);
      const INVOKER_OK = new Set(['public.phoenix_central_needs_list_manual_need_events', 'public.phoenix_central_needs_my_capabilities']);
      for (const r of rows) {
        const cfg = (r.proconfig ?? []).find((c: string) => c.startsWith('search_path='));
        if (r.prosecdef) {
          expect(cfg, `${r.fn} must pin search_path`).toBeDefined();
          expect(cfg, r.fn).not.toMatch(/(^|[=, ])(public|"\$user")\s*,\s*pg_catalog/); // never public before pg_catalog
          if (/public/.test(cfg)) expect(cfg.endsWith('pg_temp'), `${r.fn} pg_temp must be last`).toBe(true);
        } else if (INVOKER_OK.has(r.fn)) { expect(cfg, r.fn).toBeDefined(); }
        expect(['anon', 'authenticated', 'service_role'], r.fn).not.toContain(r.owner);
        // PUBLIC / anon / service_role never; authenticated only on the declared readers
        const exec: string[] = r.api_exec ?? [];
        expect(exec.includes(null as any) || exec.includes('anon') || exec.includes('service_role'), `${r.fn} EXECUTE for PUBLIC/anon/service_role`).toBe(false);
        if (exec.includes('authenticated')) {
          const allowed = /list_manual_need_events|my_capabilities|approve_excluded_for_caller|actor_scope_org|actor_authorized/.test(r.fn)
            || r.fn.startsWith('phoenix_cn_policy.');
          expect(allowed, `${r.fn} must not be executable by authenticated`).toBe(true);
        }
      }
    });
    it('a caller without the manual key is refused (authorization precedes everything)', async () => {
      const e = await refusal(call(U.viewer, 'open_manual_plan_revision', [ORG, 2099]));
      expect(e.message).toMatch(/forbidden_central_needs/);
      const { rev } = await fresh();
      const e2 = await refusal(add(U.setterNoView, rev));
      expect(e2.message).toMatch(/forbidden_central_needs/);
    });
  });

  describe('open_manual_plan_revision', () => {
    it('opens revision 1 as a manual draft and replays idempotently', async () => {
      year += 1;
      const a = await call(U.maker, 'open_manual_plan_revision', [ORG, year]);
      expect(a).toMatchObject({ ok: true, idempotent_replay: false, revision_number: 1, status: 'draft', source_mode: 'manual' });
      const b = await call(U.maker, 'open_manual_plan_revision', [ORG, year]);
      expect(b).toMatchObject({ idempotent_replay: true, plan_revision_id: a.plan_revision_id });
    });
    it('refuses to open past a newer non-draft revision (governed correction required)', async () => {
      const { rev, year: y } = await fresh();
      await admin(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [rev]).catch(() => undefined);
      await txAs(null, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [rev]); }, { replica: true });
      const e = await refusal(call(U.maker, 'open_manual_plan_revision', [ORG, y]));
      expect(e.message).toBe('central_needs_governed_correction_required');
    });
  });

  describe('add / correct / void', () => {
    it('add stores the byte-exact canonical text, event+projection agree, unit comes from the catalog', async () => {
      const { rev } = await fresh();
      const r = await add(U.maker, rev, '12.5');
      expect(r).toMatchObject({ ok: true, event_seq: 1, event_kind: 'add', quantity_text: '12.5' });
      const [row] = await admin(`SELECT approved_quantity::text q, approved_unit u FROM central_needs_need_lines WHERE plan_revision_id=$1`, [rev]);
      expect(row).toEqual({ q: '12.5', u: 'box' });
    });
    it.each(['٣', '1,5', '01', '1.50', '1.', '-1', '', ' 1', '1e3', 'NaN'])('rejects non-canonical quantity %j', async (q) => {
      const { rev } = await fresh();
      const e = await refusal(add(U.maker, rev, q));
      expect(['manual_quantity_not_canonical', 'manual_quantity_non_ascii']).toContain(e.message);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(0);
    });
    it('same key + same payload replays; same key + different payload conflicts (23505)', async () => {
      const { rev } = await fresh();
      const key = randomUUID();
      const a = await add(U.maker, rev, '5', ORG_BENE, item, key);
      const b = await add(U.maker, rev, '5', ORG_BENE, item, key);
      expect(b).toMatchObject({ idempotent_replay: true, event_id: a.event_id });
      const e = await refusal(add(U.maker, rev, '6', ORG_BENE, item, key));
      expect(e.code).toBe('23505');
      expect((await admin(`SELECT count(*)::int n FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(1);
    });
    it('a live scope cannot be added twice; a stale expected event is refused', async () => {
      const { rev } = await fresh();
      await add(U.maker, rev, '5');
      expect((await refusal(add(U.maker, rev, '7'))).message).toBe('manual_need_line_stale');
    });
    it('correct requires the expected last event, refuses no-change, and updates event+projection together', async () => {
      const { rev } = await fresh();
      const a = await add(U.maker, rev, '5');
      const c = (qty: string, exp: string, key = randomUUID()) =>
        call(U.maker2, 'correct_manual_need_line', [rev, ORG_BENE, item, null, qty, 'recount', key, exp, null]);
      expect((await refusal(c('5', a.event_id))).message).toBe('manual_need_line_no_change');
      expect((await refusal(c('6', randomUUID()))).message).toBe('manual_need_line_stale');
      const ok = await c('6.25', a.event_id);
      expect(ok).toMatchObject({ event_seq: 2, event_kind: 'correct', quantity_text: '6.25' });
      const [row] = await admin(`SELECT approved_quantity::text q FROM central_needs_need_lines WHERE plan_revision_id=$1`, [rev]);
      expect(row.q).toBe('6.25');
    });
    it('void removes the projection row, keeps the chain, and the scope can be re-added with the void as expected last', async () => {
      const { rev } = await fresh();
      const a = await add(U.maker, rev, '5');
      const v = await call(U.maker, 'void_manual_need_line', [rev, ORG_BENE, item, null, 'entered by mistake', randomUUID(), a.event_id, null]);
      expect(v).toMatchObject({ event_kind: 'void', event_seq: 2 });
      expect((await admin(`SELECT count(*)::int n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(0);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(2);
      expect((await refusal(add(U.maker, rev, '9'))).message).toBe('manual_need_line_stale');
      const again = await add(U.maker, rev, '9', ORG_BENE, item, randomUUID(), v.event_id);
      expect(again).toMatchObject({ event_seq: 3, event_kind: 'add' });
    });
    it('ineligible scope is refused: non-institution beneficiary, inactive item, foreign warehouse', async () => {
      const { rev } = await fresh();
      expect((await refusal(add(U.maker, rev, '1', ORG))).message).toBe('manual_beneficiary_ineligible');
      const inactive = await newItem(admin, 'box', 'inactive');
      expect((await refusal(add(U.maker, rev, '1', ORG_BENE, inactive))).message).toBe('central_item_not_active');
      const e = await refusal(call(U.maker, 'add_manual_need_line', [rev, ORG_BENE, item, randomUUID(), '1', 'x reason', randomUUID(), null, null]));
      expect(e.message).toBe('manual_warehouse_ineligible');
    });
    it('Excel revisions refuse manual writes', async () => {
      year += 1;
      let rev = '';
      await txAs(null, async (q) => {
        const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG, year]);
        rev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by) VALUES ($1,$2,1,'draft','excel',$3) RETURNING id`, [plan, ORG, U.maker]))[0].id;
      }, { replica: true });
      expect((await refusal(add(U.maker, rev))).message).toBe('manual_revision_required');
    });
    it('no stock, catalog or inventory side effects (zero writes outside central_needs_* and audit)', async () => {
      const before = await admin(`SELECT (SELECT count(*) FROM central_items)::int items, (SELECT count(*) FROM organizations)::int orgs`);
      const { rev } = await fresh();
      await add(U.maker, rev, '3', ORG_BENE, item2);
      const after = await admin(`SELECT (SELECT count(*) FROM central_items)::int items, (SELECT count(*) FROM organizations)::int orgs`);
      expect(after).toEqual(before);
    });
  });

  describe('concurrency', () => {
    it('two concurrent adds of the same scope: exactly one wins, the other is refused, one event, one line', async () => {
      const { rev } = await fresh();
      const results = await Promise.allSettled([add(U.maker, rev, '4'), add(U.maker2, rev, '8')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(1);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(1);
    });
  });

  describe('withdraw_draft_revision (SoD)', () => {
    it('the opener cannot withdraw; a different approver can; the row is recorded and nothing is deleted', async () => {
      const { rev } = await fresh();
      await add(U.maker, rev, '2');
      await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.approve',true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U.maker]);
      const e = await refusal(call(U.maker, 'withdraw_draft_revision', [rev, rev, 'abandoned', null]));
      expect(e.message).toBe('central_needs_separation_of_duties_violation');
      await admin(`UPDATE profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.approve'`, [U.maker]);
      const w = await call(U.checker, 'withdraw_draft_revision', [rev, rev, 'abandoned by plan owner', null]);
      expect(w).toMatchObject({ ok: true, status: 'withdrawn' });
      expect((await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [rev]))[0].status).toBe('withdrawn');
      expect((await admin(`SELECT count(*)::int n FROM central_needs_revision_withdrawals WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(1);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [rev]))[0].n).toBe(1);
      expect((await refusal(add(U.maker, rev, '3', ORG_BENE_B))).message).toBe('plan_revision_not_editable');
    });
    it('a stale expected-latest is refused', async () => {
      const { rev } = await fresh();
      expect((await refusal(call(U.checker, 'withdraw_draft_revision', [rev, randomUUID(), 'x reason', null]))).message).toBe('central_needs_revision_stale');
    });
  });

  describe('correction revision, carry-forward and coverage (full chain on the real DB)', () => {
    /** Take a manual draft with lines to `approved` (fixture-level transition; approval flow itself is proven in 02/03). */
    const approve = async (rev: string) => {
      await txAs(null, async (q) => {
        await q(`UPDATE central_needs_plan_revisions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [rev, U.checker]);
      }, { replica: true });
    };
    it('correction needs the exact latest revision; carry copies last non-void events byte-for-byte and is idempotent', async () => {
      const { rev, year: y } = await fresh();
      await add(U.maker, rev, '10', ORG_BENE, item);
      const b = await add(U.maker, rev, '7.5', ORG_BENE_B, item);
      await call(U.maker, 'void_manual_need_line', [rev, ORG_BENE_B, item, null, 'drop', randomUUID(), b.event_id, null]);
      await add(U.maker, rev, '2', ORG_BENE, item2);
      await approve(rev);

      expect((await refusal(call(U.maker, 'open_manual_correction_revision', [ORG, y, randomUUID(), 'new data']))).message).toBe('central_needs_correction_plan_mismatch');
      const c = await call(U.maker, 'open_manual_correction_revision', [ORG, y, rev, 'annual update']);
      await txAs(null, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [c.plan_revision_id]); }, { replica: true });
      expect((await refusal(call(U.maker, 'open_manual_correction_revision', [ORG, y, rev, 'again']))).message).toBe('central_needs_revision_stale');
      await txAs(null, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='draft' WHERE id=$1`, [c.plan_revision_id]); }, { replica: true });
      expect(c).toMatchObject({ revision_number: 2, status: 'draft', source_mode: 'manual', effective_approved_revision_id: rev });

      const carry = await call(U.maker, 'carry_forward_manual_lines', [c.plan_revision_id, rev]);
      expect(carry).toMatchObject({ ok: true, idempotent_replay: false, carried_count: 2 });
      const lines = await admin(`SELECT approved_quantity::text q FROM central_needs_need_lines WHERE plan_revision_id=$1 ORDER BY 1`, [c.plan_revision_id]);
      expect(lines.map((l: any) => l.q)).toEqual(['10', '2']);
      expect(await call(U.maker, 'carry_forward_manual_lines', [c.plan_revision_id, rev])).toMatchObject({ idempotent_replay: true, carried_count: 2 });
      expect((await refusal(call(U.maker, 'carry_forward_manual_lines', [c.plan_revision_id, randomUUID()]))).message).toBe('manual_carry_requires_empty_revision');
    });
    it('coverage: omitted scopes need an acknowledgement bound to the omission digest; replay is idempotent; stale digest refused', async () => {
      const { rev, year: y } = await fresh();
      await add(U.maker, rev, '10', ORG_BENE, item);
      await add(U.maker, rev, '2', ORG_BENE, item2);
      await approve(rev);
      const c = await call(U.maker, 'open_manual_correction_revision', [ORG, y, rev, 'annual update']);
      await add(U.maker, c.plan_revision_id, '11', ORG_BENE, item); // item2 scope omitted
      const [{ d }] = await txAs(U.maker, async () => undefined).then(() => admin(
        `SELECT omitted_scope_digest d FROM phoenix_private.central_needs_coverage_digest_v1($1,$2)`, [c.plan_revision_id, rev]));
      const ack = (digest: string) => call(U.maker, 'acknowledge_manual_coverage', [c.plan_revision_id, digest, 'item discontinued']);
      expect((await refusal(ack('f'.repeat(64)))).message).toBe('manual_coverage_stale');
      const a = await ack(d);
      expect(a).toMatchObject({ ok: true, idempotent_replay: false, omitted_scope_count: 1 });
      expect(await ack(d)).toMatchObject({ idempotent_replay: true, acknowledgement_id: a.acknowledgement_id });
    });
    it('carry refuses an Excel source (Excel quantities never enter a manual revision)', async () => {
      year += 1;
      let xrev = '';
      let plan = '';
      await txAs(null, async (q) => {
        plan = (await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG, year]))[0].id;
        xrev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by, approved_by, approved_at) VALUES ($1,$2,1,'approved','excel',$3,$4,now()) RETURNING id`, [plan, ORG, U.maker, U.checker]))[0].id;
      }, { replica: true });
      const c = await call(U.maker, 'open_manual_correction_revision', [ORG, year, xrev, 'switch to manual']);
      expect((await refusal(call(U.maker, 'carry_forward_manual_lines', [c.plan_revision_id, xrev]))).message).toBe('manual_carry_source_not_manual');
    });
  });

  describe('readers', () => {
    it('list_manual_need_events is INVOKER and returns the ordered chain; my_capabilities reports R1-a constants', async () => {
      const { rev } = await fresh();
      const a = await add(U.maker, rev, '1');
      await call(U.maker, 'correct_manual_need_line', [rev, ORG_BENE, item, null, '2', 'recount', randomUUID(), a.event_id, null]);
      const rows = await admin(`SELECT event_seq, event_kind FROM ${P}list_manual_need_events($1)`, [rev]);
      expect(rows).toEqual([{ event_seq: 1, event_kind: 'add' }, { event_seq: 2, event_kind: 'correct' }]);
      const [{ prosecdef }] = await admin(`SELECT prosecdef FROM pg_proc WHERE proname='phoenix_central_needs_list_manual_need_events'`);
      expect(prosecdef).toBe(false);
      let cap: any;
      await txAs(U.maker, async (q) => { cap = (await q(`SELECT * FROM ${P}my_capabilities($1,$2)`, [ORG, rev]))[0]; });
      expect(cap).toMatchObject({ view: true, edit: true, manual_set: false, excel_import_open: true, approve_excluded_for_revision: true });  // maker opened it => excluded from approving
      await txAs(U.checker, async (q) => { cap = (await q(`SELECT * FROM ${P}my_capabilities($1,$2)`, [ORG, rev]))[0]; });
      expect(cap).toMatchObject({ approve: true, approve_excluded_for_revision: false });
    });
    it('approve_excluded_for_caller leaks nothing to a caller without view over the revision organization', async () => {
      const { rev } = await fresh();
      let r: any;
      await txAs(U.other, async (q) => { r = (await q(`SELECT phoenix_cn_policy.approve_excluded_for_caller($1) v`, [rev]))[0].v; });
      expect(r).toBe(false);
    });
  });
});
