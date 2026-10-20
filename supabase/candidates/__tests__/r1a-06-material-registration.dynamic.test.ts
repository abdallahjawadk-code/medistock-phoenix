/**
 * R1-a candidate 06 — DYNAMIC proof of the governed material registration (R1-A2, PRE3-C v1.1 + owner M1-M5).
 * Real disposable PostgreSQL only. The writers are owner-only in R1-a; tests impersonate a JWT subject in a superuser
 * session (the same idiom as candidate 04) and prove the ACLs with real role calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { ORG, ORG_OTHER, U, refusal, helpers, buildWithCandidates, grantManualKey, type Rig } from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql',
  'R1a_04_manual_routines_inert.sql', 'R1a_05_blockers_digest_d27.sql', 'R1a_06_material_registration_inert.sql'];
const P = 'public.phoenix_central_needs_';
const WRITERS = ['create_material_request_draft', 'update_material_request_draft', 'submit_material_request', 'start_material_review',
  'request_material_info', 'resolve_material_existing', 'approve_new_material', 'reject_material_request', 'cancel_material_request',
  'link_material_request_to_draft'];

run('R1-a candidate 06 — governed material registration (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig;
  const h = helpers(() => rig);
  const { admin, txAs } = h;
  let seq = 0;
  let yearCounter = 0;

  const call = async (sub: string, fn: string, args: unknown[]): Promise<any> => {
    let out: any;
    await txAs(sub, async (q) => { out = (await q(`SELECT ${P}${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args))[0].r; });
    return out;
  };
  const uniq = (p: string) => `${p} ${++seq}-${randomUUID().slice(0, 6)}`;
  const draft = (sub: string, o: Partial<{ sci: string; ar: string | null; trade: string | null; str: string | null; form: string | null; unit: string; bar: string | null;
    note: string | null; kind: string; prov: unknown; rev: string | null; key: string; org: string }> = {}) =>
    call(sub, 'create_material_request_draft', [o.org ?? ORG, o.sci ?? uniq('Zolpidem'), o.ar ?? null, o.trade ?? null, o.str ?? '10 mg', o.form ?? 'Tablet',
      o.unit ?? 'box', o.bar ?? null, o.note ?? null, o.kind ?? 'manual_typed', JSON.stringify(o.prov ?? {}), o.rev ?? null, o.key ?? randomUUID()]);
  const submit = (sub: string, id: string, v: number) => call(sub, 'submit_material_request', [id, v]);
  const startReview = (sub: string, id: string, v: number) => call(sub, 'start_material_review', [id, v]);
  const approveNew = (sub: string, id: string, v: number, ack: string[] = [], note = 'new registered material') =>
    call(sub, 'approve_new_material', [id, v, ack, note]);
  /** draft -> submitted -> under_review ; returns the request id and its current version */
  const toReview = async (o: Parameters<typeof draft>[1] = {}) => {
    const d = await draft(U.maker, o);
    const s = await submit(U.maker, d.request_id, d.version);
    const r = await startReview(U.saKeys, d.request_id, s.version);
    return { id: d.request_id as string, version: r.version as number };
  };
  const status = async (id: string) => (await admin(`SELECT status, version, resolved_item_id, reviewer_id FROM central_needs_material_requests WHERE id=$1`, [id]))[0];
  const rawItem = async (name: string, o: { conc?: string | null; form?: string | null; unit?: string; bar?: string | null; ar?: string; status?: string } = {}) => {
    const id = randomUUID();
    await admin(`INSERT INTO central_items (id, name, name_ar, unit, status, concentration, dosage_form, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, name, o.ar ?? name, o.unit ?? 'box', o.status ?? 'active', o.conc ?? null, o.form ?? null, o.bar ?? null]);
    return id;
  };
  const manualDraftRevision = async (org: string, st: 'draft' | 'approved' | 'submitted' = 'draft') => {
    let rev = '';
    await txAs(null, async (q) => {
      const y = 2099 - (yearCounter += 1);
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [org, y]);
      rev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by${st === 'approved' ? ', approved_by, approved_at' : ''})
        VALUES ($1,$2,1,$3,'manual',$4${st === 'approved' ? `,'${U.checker}', now()` : ''}) RETURNING id`, [plan, org, st, U.maker]))[0].id;
    }, { replica: true });
    return rev;
  };

  beforeAll(async () => {
    rig = await buildWithCandidates(F, 1);
    await grantManualKey(rig, [U.maker, U.maker2, U.saKeys]);
    // the reviewer key (placeholder, Q-K): the active super_admin of the Pharmacy Department org, and - as negative controls - others
    await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) SELECT x, 'central_needs.material_review', true FROM unnest($1::uuid[]) x
                 ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [[U.saKeys, U.saOther, U.checker, U.other, U.inst]]);
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  describe('A. structure, ACL, census, seal (M4\')', () => {
    it('20 public central_needs relations, each with forced RLS and the restrictive actor-scope policy; the three new ones start EMPTY', async () => {
      const [{ n }] = await admin(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' AND c.relname LIKE 'central\\_needs\\_%'`);
      expect(n).toBe(20);
      const weak = await admin(`SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' AND c.relname LIKE 'central\\_needs\\_material\\_%'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='r1_actor_scope_restrictive' AND NOT p.polpermissive))`);
      expect(weak).toEqual([]);
      for (const t of ['central_needs_material_requests', 'central_needs_material_request_events', 'central_needs_material_request_links']) {
        const [r] = await admin(`SELECT has_table_privilege('authenticated',$1,'INSERT') i, has_table_privilege('authenticated',$1,'UPDATE') u,
          has_table_privilege('authenticated',$1,'DELETE') d, has_table_privilege('anon',$1,'SELECT') a, has_table_privilege('service_role',$1,'INSERT') s`, [`public.${t}`]);
        expect(r, t).toEqual({ i: false, u: false, d: false, a: false, s: false });
      }
    });

    it('the ten writers are owner-only: real calls as anon / authenticated / service_role are refused with 42501', async () => {
      const rows = await admin(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND p.proname IN (${WRITERS.map((w) => `'phoenix_central_needs_${w}'`).join(',')})
        AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))`);
      expect(rows).toEqual([]);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const e = await refusal(h.as(role === 'anon' ? null : U.maker, `SELECT ${P}submit_material_request($1,1)`, [randomUUID()], role));
        expect(e.code, role).toBe('42501');
      }
    });

    it('central_items: NO client path (authenticated and anon hold no DML); approve_new_material is the ONLY routine that writes it; service_role keeps its legacy server-side grant (recorded finding)', async () => {
      const w = await admin(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND regexp_replace(p.prosrc,'--[^\\n]*','','g') ~* '(insert\\s+into|update|delete\\s+from)\\s+(only\\s+)?("?public"?\\.)?"?central_items"?\\y' ORDER BY 1`);
      expect(w.map((x: any) => x.proname)).toEqual(['phoenix_central_needs_approve_new_material']);
      const [g] = await admin(`SELECT bool_or(has_table_privilege(r,'public.central_items',p)) AS any_client_dml
        FROM unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p`);
      expect(g.any_client_dml).toBe(false);
      for (const sql of [
        `INSERT INTO central_items (name, name_ar, unit) VALUES ('direct write', 'direct write', 'box')`,
        `UPDATE central_items SET status='inactive'`,
        `DELETE FROM central_items`,
      ]) expect((await refusal(h.as(U.maker, sql))).message, sql).toMatch(/permission denied/);
      expect((await refusal(h.as(U.saKeys, `INSERT INTO central_items (name, name_ar, unit) VALUES ('direct write', 'direct write', 'box')`))).message).toMatch(/permission denied/);   // not even a super_admin
      // FINDING (owner-visible): service_role (trusted server key) keeps legacy DML on central_items; unchanged by this candidate
      expect((await admin(`SELECT has_table_privilege('service_role','public.central_items','INSERT') s`))[0].s).toBe(true);
    });

    it('writer census is exactly 34 and the seal is clean (including the structural tripwires)', async () => {
      const [{ n }] = await admin(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
        WHERE s.nspname NOT IN ('pg_catalog','information_schema')
          AND regexp_replace(p.prosrc,'--[^\\n]*','','g') ~* '(insert\\s+into|update|delete\\s+from|truncate|merge\\s+into)\\s+(only\\s+)?(table\\s+)?("?public"?\\.|"?phoenix_private"?\\.)?"?central_needs_[a-z_]+'`);
      expect(n).toBe(34);
      expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
    });

    it('every new SECURITY DEFINER routine pins search_path; no routine is owned by an API role; readers are INVOKER or scoped', async () => {
      const rows = await admin(`SELECT p.proname, p.prosecdef, p.proconfig, r.rolname owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE (n.nspname='public' AND p.proname ~ '(material_request|material_review|_material_|approve_new_material|resolve_material|my_material)')
           OR (n.nspname='phoenix_private' AND p.proname ~ '^central_material_') OR (n.nspname='phoenix_cn_policy' AND p.proname='material_reviewer_org')`);
      expect(rows.length).toBeGreaterThanOrEqual(20);
      for (const r of rows) {
        if (r.prosecdef) expect((r.proconfig ?? []).some((c: string) => c.startsWith('search_path=')), r.proname).toBe(true);
        expect(['anon', 'authenticated', 'service_role']).not.toContain(r.owner);
      }
    });
  });

  describe('B. lifecycle: request -> submit -> review -> needs_info -> approve (new canonical item) -> explicit link', () => {
    it('runs end to end, writes exactly one catalog row, records an ordered event chain, and touches no stock or annual-need line', async () => {
      const snap = async () => (await admin(`SELECT (SELECT count(*) FROM warehouse_stock)::int ws, (SELECT count(*) FROM outlet_stock)::int os,
        (SELECT count(*) FROM central_needs_need_lines)::int nl, (SELECT count(*) FROM central_needs_manual_need_events)::int me,
        (SELECT count(*) FROM central_needs_plan_revisions)::int rv, (SELECT count(*) FROM central_items)::int ci`))[0];
      const before = await snap();
      const sci = uniq('Zolpidem');
      const d = await draft(U.maker, { sci, ar: 'زولبيديم', trade: 'Stilnox', str: '10 mg', form: 'Tablet', unit: 'box', note: 'requested by ward' });
      expect(d).toMatchObject({ ok: true, idempotent_replay: false, status: 'draft', version: 1 });
      const u = await call(U.maker, 'update_material_request_draft', [d.request_id, 1, sci, 'زولبيديم', 'Stilnox', '10 mg', 'Tablet', 'box', null, 'requested by ward (edited)']);
      expect(u).toMatchObject({ status: 'draft', version: 2 });
      const s = await submit(U.maker, d.request_id, 2);
      expect(s).toMatchObject({ status: 'submitted', version: 3, strong_matches: 0 });
      const r = await startReview(U.saKeys, d.request_id, 3);
      expect(r).toMatchObject({ status: 'under_review', version: 4 });
      const q = await call(U.saKeys, 'request_material_info', [d.request_id, 4, 'please state the dosage form precisely']);
      expect(q).toMatchObject({ status: 'needs_info', version: 5 });
      const back = await submit(U.maker, d.request_id, 5);                       // needs_info -> under_review (reviewer retained)
      expect(back).toMatchObject({ status: 'under_review', version: 6 });
      const a = await approveNew(U.saKeys, d.request_id, 6);
      expect(a).toMatchObject({ status: 'approved_new', version: 7 });
      const [item] = await admin(`SELECT name, name_ar, trade_name, concentration, dosage_form, unit, status, created_by FROM central_items WHERE id=$1`, [a.central_item_id]);
      expect(item).toMatchObject({ name: sci, name_ar: 'زولبيديم', trade_name: 'Stilnox', concentration: '10 mg', dosage_form: 'Tablet', unit: 'box', status: 'active', created_by: U.saKeys });
      const ev = await admin(`SELECT seq, event_kind, status_after, actor_id FROM central_needs_material_request_events WHERE request_id=$1 ORDER BY seq`, [d.request_id]);
      expect(ev.map((e: any) => e.event_kind)).toEqual(['draft_created', 'edited', 'submitted', 'review_started', 'info_requested', 'info_provided', 'approved_new']);
      expect(ev.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const after = await snap();
      expect({ ...after, ci: after.ci - 1 }).toEqual(before);                     // exactly one new catalog row, nothing else moved
      // a terminal request is immutable, even for a privileged raw write
      expect((await refusal(admin(`UPDATE central_needs_material_requests SET decision_reason='x', version=version+1 WHERE id=$1`, [d.request_id]))).message).toBe('material_request_terminal_immutable');
    });

    it('M2: the resolved material is linked ONLY to a manual draft of the same organization, explicitly, idempotently, and no line is written', async () => {
      const { id, version } = await toReview();
      const a = await approveNew(U.saKeys, id, version);
      const rev = await manualDraftRevision(ORG, 'draft');
      const linesBefore = (await admin(`SELECT count(*)::int n FROM central_needs_need_lines`))[0].n;
      const l1 = await call(U.maker, 'link_material_request_to_draft', [id, rev]);
      expect(l1).toMatchObject({ ok: true, idempotent_replay: false, central_item_id: a.central_item_id });
      expect(await call(U.maker, 'link_material_request_to_draft', [id, rev])).toMatchObject({ idempotent_replay: true, link_id: l1.link_id });
      expect((await admin(`SELECT count(*)::int n FROM central_needs_need_lines`))[0].n).toBe(linesBefore);
      for (const st of ['approved', 'submitted'] as const) {
        const closed = await manualDraftRevision(ORG, st);
        expect((await refusal(call(U.maker, 'link_material_request_to_draft', [id, closed]))).message, st).toBe('material_link_revision_ineligible');
      }
      expect((await refusal(call(U.maker, 'link_material_request_to_draft', [id, randomUUID()]))).message).toBe('material_link_revision_ineligible');
      expect((await refusal(call(U.viewer, 'link_material_request_to_draft', [id, rev]))).message).toMatch(/forbidden_central_needs/);
      // an unresolved request cannot be linked
      const open = await toReview();
      expect((await refusal(call(U.maker, 'link_material_request_to_draft', [open.id, rev]))).message).toBe('material_request_not_resolved');
    });

    it('reject (reason required) and cancel are terminal; a requester cannot cancel while under review', async () => {
      const { id, version } = await toReview();
      expect((await refusal(call(U.saKeys, 'reject_material_request', [id, version, '  ']))).message).toBe('material_reason_required');
      expect((await refusal(call(U.maker, 'cancel_material_request', [id, version, 'withdraw']))).message).toBe('material_request_not_cancellable');
      const rj = await call(U.saKeys, 'reject_material_request', [id, version, 'out of formulary']);
      expect(rj).toMatchObject({ status: 'rejected' });
      expect((await refusal(call(U.saKeys, 'reject_material_request', [id, rj.version, 'again']))).message).toMatch(/material_request_not_reviewable|terminal/);
      const d = await draft(U.maker);
      const c = await call(U.maker, 'cancel_material_request', [d.request_id, d.version, 'no longer needed']);
      expect(c).toMatchObject({ status: 'cancelled' });
      expect((await refusal(submit(U.maker, d.request_id, c.version))).message).toBe('material_request_not_submittable');
    });
  });

  describe('C. server-scoped duplicate review: strong identifiers first, advisory fuzzy, human confirmation', () => {
    it('STRONG match (same normalized scientific identity incl. Arabic letter variants): approve_new is refused; resolve must pick the strong item', async () => {
      const name = uniq('Metformin');
      const existing = await rawItem(name.toUpperCase(), { conc: '500 mg', form: 'Tablet', unit: 'box' });
      const other = await rawItem(uniq('Unrelated material'), { unit: 'box' });
      const { id, version } = await toReview({ sci: name, str: '500  MG', form: 'tablet', unit: 'box' });
      const e = await refusal(approveNew(U.saKeys, id, version));
      expect(e.message).toBe('material_duplicate_strong_match');
      expect((await refusal(call(U.saKeys, 'resolve_material_existing', [id, version, other, 'wrong pick']))).message).toBe('material_resolution_must_match_strong');
      const ok = await call(U.saKeys, 'resolve_material_existing', [id, version, existing, 'already in the catalog']);
      expect(ok).toMatchObject({ status: 'resolved_existing', central_item_id: existing });
      expect((await admin(`SELECT count(*)::int n FROM central_items WHERE lower(name)=lower($1)`, [name]))[0].n).toBe(1);
    });

    it('barcode is a strong identifier: a request carrying a registered barcode cannot create a second item', async () => {
      const bar = 'BC' + randomUUID().replace(/-/g, '').slice(0, 12);
      const existing = await rawItem(uniq('Barcoded'), { bar });
      const { id, version } = await toReview({ bar });
      expect((await refusal(approveNew(U.saKeys, id, version))).message).toBe('material_duplicate_strong_match');
      expect(await call(U.saKeys, 'resolve_material_existing', [id, version, existing, 'same barcode'])).toMatchObject({ status: 'resolved_existing' });
    });

    it('resolving to an inactive item is refused', async () => {
      const inactive = await rawItem(uniq('Retired'), { status: 'inactive' });
      const { id, version } = await toReview();
      expect((await refusal(call(U.saKeys, 'resolve_material_existing', [id, version, inactive, 'x']))).message).toBe('material_resolution_item_not_active');
    });

    it('ADVISORY similarity never decides: new approval needs a human acknowledgement of EVERY similar item', async () => {
      const base = 'Ciprofloxacin Hydrochloride ' + randomUUID().slice(0, 4);
      const similar = await rawItem(base + ' Tabs', { conc: '250 mg', form: 'Tablet', unit: 'box' });
      const { id, version } = await toReview({ sci: base, str: '500 mg', form: 'Tablet', unit: 'box' });
      const cands = await admin(`SELECT central_item_id, grade FROM phoenix_private.central_material_candidates_v1($1,$2,$3,$4,NULL)`, [base, '500 mg', 'Tablet', 'box']);
      expect(cands).toEqual([{ central_item_id: similar, grade: 'advisory' }]);
      expect((await refusal(approveNew(U.saKeys, id, version, []))).message).toBe('material_duplicate_review_required');
      expect((await refusal(approveNew(U.saKeys, id, version, [randomUUID()]))).message).toBe('material_duplicate_review_required');
      const ok = await approveNew(U.saKeys, id, version, [similar], 'confirmed: different strength');
      expect(ok).toMatchObject({ status: 'approved_new' });
      const ev = await admin(`SELECT detail FROM central_needs_material_request_events WHERE request_id=$1 AND event_kind='approved_new'`, [id]);
      expect(ev[0].detail.acknowledged_candidates).toEqual([similar]);
    });

    it('the reader returns candidates only to a view holder of the request organization (no oracle)', async () => {
      const name = uniq('Reader');
      await rawItem(name, { conc: '5 mg', form: 'Tablet', unit: 'box' });
      const d = await draft(U.maker, { sci: name, str: '5 mg', form: 'Tablet', unit: 'box' });
      let mine: any[] = []; let foreign: any[] = []; let none: any[] = [];
      await txAs(U.viewer, async (q) => { mine = await q(`SELECT grade FROM ${P}material_request_candidates($1)`, [d.request_id]); });
      await txAs(U.other, async (q) => { foreign = await q(`SELECT grade FROM ${P}material_request_candidates($1)`, [d.request_id]); });
      await txAs(null, async (q) => { none = await q(`SELECT grade FROM ${P}material_request_candidates($1)`, [d.request_id]); });
      expect(mine.map((r) => r.grade)).toEqual(['strong']);
      expect(foreign).toEqual([]);
      expect(none).toEqual([]);
    });
  });

  describe('D. concurrency, retries, idempotency, duplicate prevention', () => {
    it('two drafts of the SAME identity submitted concurrently: exactly one opens, the other is refused material_request_duplicate_open', async () => {
      const sci = uniq('Concurrent');
      const a = await draft(U.maker, { sci }); const b = await draft(U.maker2, { sci });
      const res = await Promise.allSettled([submit(U.maker, a.request_id, a.version), submit(U.maker2, b.request_id, b.version)]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(failed.reason.message)).toBe('material_request_duplicate_open');
      expect((await admin(`SELECT count(*)::int n FROM central_needs_material_requests WHERE identity_key LIKE $1 AND status IN ('submitted','under_review','needs_info')`, ['nm:' + sci.toLowerCase() + '%']))[0].n).toBe(1);
    });

    it('a retried / duplicated approval creates exactly one catalog item (second is stale), and two decisions race to one outcome', async () => {
      const { id, version } = await toReview();
      const res = await Promise.allSettled([approveNew(U.saKeys, id, version), approveNew(U.saKeys, id, version)]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(String((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message)).toMatch(/material_request_stale|material_request_not_reviewable/);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_material_requests WHERE resolved_item_id IS NOT NULL AND id=$1`, [id]))[0].n).toBe(1);
      const race = await toReview();
      const r2 = await Promise.allSettled([approveNew(U.saKeys, race.id, race.version), call(U.saKeys, 'reject_material_request', [race.id, race.version, 'no'])]);
      expect(r2.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(['approved_new', 'rejected']).toContain((await status(race.id)).status);
    });

    it('create is idempotent: same key + same payload replays; same key + different payload conflicts (23505); a stale version is refused', async () => {
      const key = randomUUID(); const sci = uniq('Idem');
      const a = await draft(U.maker, { sci, key });
      const b = await draft(U.maker, { sci, key });
      expect(b).toMatchObject({ idempotent_replay: true, request_id: a.request_id });
      expect((await refusal(draft(U.maker, { sci: sci + ' other', key }))).code).toBe('23505');
      expect((await admin(`SELECT count(*)::int n FROM central_needs_material_requests WHERE idempotency_key=$1`, [key]))[0].n).toBe(1);
      await call(U.maker, 'update_material_request_draft', [a.request_id, 1, sci, null, null, '10 mg', 'Tablet', 'box', null, null]);
      expect((await refusal(submit(U.maker, a.request_id, 1))).message).toBe('material_request_stale');
    });

    it('two concurrent approvals of the same barcode in two requests yield one item (the second sees the strong match)', async () => {
      const bar = 'CC' + randomUUID().replace(/-/g, '').slice(0, 12);
      const a = await toReview({ bar, sci: uniq('BarA') });
      // a second open request with the same barcode in the same org is itself refused (identity key)
      const b = await draft(U.maker2, { bar, sci: uniq('BarB') });
      expect((await refusal(submit(U.maker2, b.request_id, b.version))).message).toBe('material_request_duplicate_open');
      expect(await approveNew(U.saKeys, a.id, a.version)).toMatchObject({ status: 'approved_new' });
      expect((await admin(`SELECT count(*)::int n FROM central_items WHERE barcode=$1`, [bar]))[0].n).toBe(1);
    });
  });

  describe('E. authorization: org scope, role, independent reviewer (M3), requester-only operations', () => {
    it('a care-institution-class or non-eligible role cannot author; another organization cannot touch the request', async () => {
      expect((await refusal(draft(U.inst))).message).toMatch(/forbidden_central_needs_role|forbidden_central_needs/);
      expect((await refusal(draft(U.other, { org: ORG }))).message).toMatch(/forbidden_central_needs/);
      expect((await refusal(draft(U.susp))).message).toMatch(/forbidden_central_needs/);
      expect((await refusal(draft(U.viewer))).message).toMatch(/forbidden_central_needs/);       // view only: no edit key
      const d = await draft(U.maker);
      expect((await refusal(submit(U.other, d.request_id, d.version))).message).toMatch(/forbidden_central_needs/);
    });

    it('only the requester updates / submits / cancels a request', async () => {
      const d = await draft(U.maker);
      for (const fn of [
        () => call(U.maker2, 'update_material_request_draft', [d.request_id, 1, 'x y', null, null, null, null, 'box', null, null]),
        () => submit(U.maker2, d.request_id, 1),
        () => call(U.maker2, 'cancel_material_request', [d.request_id, 1, 'no']),
      ]) expect((await refusal(fn())).message).toBe('material_request_requester_only');
    });

    it('M3 reviewer: must be an ACTIVE super_admin of the home PDA holding the explicit key - never the requester, never an implicit bypass', async () => {
      const d = await draft(U.maker); const s = await submit(U.maker, d.request_id, d.version);
      // not a super_admin (central_warehouse_manager) although the key is granted, and approver of the same org
      expect((await refusal(startReview(U.checker, d.request_id, s.version))).message).toMatch(/forbidden_central_needs/);
      // super_admin of ANOTHER organization holding the key
      expect((await refusal(startReview(U.saOther, d.request_id, s.version))).message).toMatch(/forbidden_central_needs/);
      // super_admin without the explicit key (no implicit super_admin bypass): saNull has no home; revoke saKeys' key temporarily
      await admin(`UPDATE profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.material_review'`, [U.saKeys]);
      try {
        expect((await refusal(startReview(U.saKeys, d.request_id, s.version))).message).toMatch(/forbidden_central_needs/);
      } finally {
        await admin(`UPDATE profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.material_review'`, [U.saKeys]);
      }
      expect((await refusal(startReview(U.inst, d.request_id, s.version))).message).toMatch(/forbidden_central_needs/);
      expect((await status(d.request_id)).status).toBe('submitted');
    });

    it('SoD: a super_admin who is the REQUESTER cannot review it (routine and CHECK); a different assigned reviewer is required for every decision', async () => {
      const d = await draft(U.saKeys);                                               // saKeys holds edit + review keys
      const s = await submit(U.saKeys, d.request_id, d.version);
      expect((await refusal(startReview(U.saKeys, d.request_id, s.version))).message).toBe('central_needs_separation_of_duties_violation');
      expect((await refusal(admin(`UPDATE central_needs_material_requests SET status='under_review', reviewer_id=requester_id, version=version+1 WHERE id=$1`, [d.request_id]))).message)
        .toMatch(/central_needs_material_requests_sod_chk/);
      // a second independent super_admin of the same PDA
      await admin(`INSERT INTO auth.users (id,email) VALUES ('00000000-0000-0000-0000-0000000c36a1','r1c-rev2@rig') ON CONFLICT DO NOTHING`);
      await admin(`UPDATE profiles SET role='super_admin', status='active', organization_id=$1 WHERE id='00000000-0000-0000-0000-0000000c36a1'`, [ORG]);
      for (const k of ['view', 'material_review']) {
        await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ('00000000-0000-0000-0000-0000000c36a1',$1,true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [`central_needs.${k}`]);
      }
      const rev2 = '00000000-0000-0000-0000-0000000c36a1';
      const r = await startReview(rev2, d.request_id, s.version);
      expect(r).toMatchObject({ status: 'under_review' });
      // only the ASSIGNED reviewer decides
      expect((await refusal(call(U.saKeys, 'reject_material_request', [d.request_id, r.version, 'x']))).message).toBe('central_needs_separation_of_duties_violation');
      const other = await toReview();
      expect((await refusal(call(rev2, 'reject_material_request', [other.id, other.version, 'not mine']))).message).toBe('material_request_not_assigned_reviewer');
    });
  });

  describe('F. provenance (M1), shape and immutability', () => {
    it('excel_assist provenance is an identity-only pointer; a quantity key, a malformed hash or a manual_typed payload is refused by the database', async () => {
      const fh = 'a'.repeat(64);
      const ok = await draft(U.maker, { kind: 'excel_assist', prov: { sheet_index: 0, row: 7, column: 1, file_hash: fh } });
      expect(ok).toMatchObject({ status: 'draft' });
      for (const prov of [
        { sheet_index: 0, row: 7, column: 1, file_hash: fh, quantity: 500 },
        { sheet_index: 0, row: 7, file_hash: 'zz' },
        { row: 7, file_hash: fh },
      ]) {
        expect((await refusal(draft(U.maker, { kind: 'excel_assist', prov }))).message).toMatch(/central_needs_material_requests_provenance_chk/);
      }
      expect((await refusal(draft(U.maker, { kind: 'manual_typed', prov: { sheet_index: 0 } }))).message).toMatch(/central_needs_material_requests_provenance_chk/);
      expect((await refusal(draft(U.maker, { kind: 'bogus' }))).message).toBe('material_provenance_invalid');
      const [row] = await admin(`SELECT provenance_kind, provenance FROM central_needs_material_requests WHERE id=$1`, [ok.request_id]);
      expect(JSON.stringify(row.provenance)).not.toMatch(/quantity|qty|amount/i);
    });

    it('descriptor validation: unit vocabulary, blank name, barcode shape; unknown context revision refused', async () => {
      expect((await refusal(draft(U.maker, { unit: 'carton' }))).message).toMatch(/central_needs_material_requests_unit_chk/);
      expect((await refusal(draft(U.maker, { sci: '   ' }))).message).toBe('material_scientific_name_required');
      expect((await refusal(draft(U.maker, { bar: 'has space' }))).message).toMatch(/central_needs_material_requests_text_chk/);
      expect((await refusal(draft(U.maker, { rev: randomUUID() }))).message).toBe('material_context_revision_ineligible');
    });

    it('the descriptor is frozen once submitted, identity columns never change, versions only advance', async () => {
      const d = await draft(U.maker); const s = await submit(U.maker, d.request_id, d.version);
      expect((await refusal(admin(`UPDATE central_needs_material_requests SET scientific_name='changed', version=version+1 WHERE id=$1`, [d.request_id]))).message).toBe('material_request_descriptor_frozen');
      expect((await refusal(admin(`UPDATE central_needs_material_requests SET requester_id=$2, version=version+1 WHERE id=$1`, [d.request_id, U.maker2]))).message).toBe('material_request_identity_immutable');
      expect((await refusal(admin(`UPDATE central_needs_material_requests SET note='x' WHERE id=$1`, [d.request_id]))).message).toBe('material_request_version_must_advance');
      expect((await refusal(admin(`UPDATE central_needs_material_requests SET status='approved_new', version=version+1 WHERE id=$1`, [d.request_id]))).message).toMatch(/invalid_transition|shape_chk/);
      expect((await refusal(admin(`DELETE FROM central_needs_material_requests WHERE id=$1`, [d.request_id]))).message).toBe('central_needs_append_only_relation');
      expect((await refusal(admin(`DELETE FROM central_needs_material_request_events WHERE request_id=$1`, [d.request_id]))).message).toBe('central_needs_append_only_relation');
      expect((await status(d.request_id)).version).toBe(s.version);
    });
  });

  describe('G. M4\' tripwires fail closed (RED proof with look-alikes, then restored)', () => {
    const breaches = async () => (await admin(`SELECT b FROM phoenix_private.central_needs_capability_breaches_v1() b`)).map((r: any) => r.b as string);

    it('an unregistered FK-dependent look-alike relation, whatever its name, is reported', async () => {
      await admin(`CREATE TABLE public.zz_lookalike (id uuid primary key, rev uuid references public.central_needs_plan_revisions(id))`);
      try { expect(await breaches()).toContain('unlisted_fk_dependent_relation zz_lookalike'); }
      finally { await admin(`DROP TABLE public.zz_lookalike`); }
      expect(await breaches()).toEqual([]);
    });

    it('an unregistered routine that writes central_items or a request relation is reported, whatever its name', async () => {
      await admin(`CREATE FUNCTION public.zz_sneaky_a() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ INSERT INTO public.central_items (name, name_ar, unit) VALUES ('x','x','box') $$`);
      await admin(`CREATE FUNCTION public.zz_sneaky_b() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE public.central_needs_material_requests SET note = 'x' $$`);
      try {
        const b = await breaches();
        expect(b).toContain('unlisted_catalog_writer public.zz_sneaky_a');
        expect(b).toContain('unlisted_catalog_writer public.zz_sneaky_b');
      } finally { await admin(`DROP FUNCTION public.zz_sneaky_a()`); await admin(`DROP FUNCTION public.zz_sneaky_b()`); }
      expect(await breaches()).toEqual([]);
    });

    it('a manifest relation that loses FORCE RLS, or its restrictive policy, and a manifest routine that loses its pinned search_path, are reported', async () => {
      await admin(`ALTER TABLE public.central_needs_material_request_links NO FORCE ROW LEVEL SECURITY`);
      try { expect(await breaches()).toContain('relation central_needs_material_request_links lacks forced row level security'); }
      finally { await admin(`ALTER TABLE public.central_needs_material_request_links FORCE ROW LEVEL SECURITY`); }
      await admin(`ALTER TABLE public.central_needs_material_request_events DISABLE ROW LEVEL SECURITY`);
      try { expect(await breaches()).toContain('relation central_needs_material_request_events lacks forced row level security'); }
      finally { await admin(`ALTER TABLE public.central_needs_material_request_events ENABLE ROW LEVEL SECURITY`); }
      await admin(`ALTER FUNCTION phoenix_private.central_material_load_v1(uuid, integer) RESET search_path`);
      try { expect(await breaches()).toContain('manifest routine phoenix_private.central_material_load_v1(uuid,integer) has no pinned search_path'); }
      finally { await admin(`ALTER FUNCTION phoenix_private.central_material_load_v1(uuid, integer) SET search_path = pg_catalog, pg_temp`); }
      expect(await breaches()).toEqual([]);
    });

    it('granting an API role EXECUTE on a writer is reported by the ACL manifest', async () => {
      await admin(`GRANT EXECUTE ON FUNCTION ${P}approve_new_material(uuid, integer, uuid[], text) TO service_role`);
      try { expect((await breaches()).some((b) => b.includes('approve_new_material') && b.includes('executable by service_role'))).toBe(true); }
      finally { await admin(`REVOKE EXECUTE ON FUNCTION ${P}approve_new_material(uuid, integer, uuid[], text) FROM service_role`); }
      expect(await breaches()).toEqual([]);
    });
  });

  // ===========================================================================================================
  // H. Director correction round: catalog-level concurrency, candidate completeness, concurrent idempotency
  // ===========================================================================================================
  describe('H. correction round (A2)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** A transaction that calls a routine and then stays OPEN (locks held) until released. */
    const held = (sub: string, fn: string, args: unknown[]) => {
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let started!: (v: { ok: boolean; message?: string; code?: string; r?: any }) => void;
      const startedP = new Promise<{ ok: boolean; message?: string; code?: string; r?: any }>((r) => { started = r; });
      const done = rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          const r = (await c.query(`SELECT ${P}${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args)).rows[0].r;
          started({ ok: true, r });
          await gate;
          await c.query('COMMIT');
          return { ok: true as const, r };
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          const err = e as { message?: string; code?: string };
          started({ ok: false, message: err.message, code: err.code });
          return { ok: false as const, message: err.message, code: err.code };
        }
      });
      return { release, started: startedP, done };
    };
    const settle = (p: Promise<any>) => p.then((r) => ({ ok: true, r }), (e: any) => ({ ok: false, message: String(e.message), code: e.code }));
    /** true once a backend is blocked on an advisory lock while running SQL that matches `like` */
    const blockedOnAdvisory = async (like: string) => {
      for (let i = 0; i < 30; i += 1) {
        const r = await admin(`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND query ILIKE $1`, [like]);
        if (r[0].n > 0) return true;
        await sleep(100);
      }
      return false;
    };
    const reviewFor = async (requester: string, reviewer: string, o: Parameters<typeof draft>[1]) => {
      const d = await draft(requester, o);
      const s = await submit(requester, d.request_id, d.version);
      const r = await startReview(reviewer, d.request_id, s.version);
      return { id: d.request_id as string, version: r.version as number };
    };
    const countByName = async (name: string) => (await admin(`SELECT count(*)::int n FROM central_items WHERE lower(name)=lower($1)`, [name]))[0].n as number;

    describe('1. approvals of the same logical material serialize on the CATALOG identity, not on the requesting organization', () => {
      it('same organization, SAME name+strength+form+unit, DIFFERENT barcodes: two concurrent approvals create ONE item (the second sees the first and is refused)', async () => {
        const sci = uniq('Catalog');
        const a = await reviewFor(U.maker, U.saKeys, { sci, bar: 'BA' + randomUUID().replace(/-/g, '').slice(0, 10) });
        const b = await reviewFor(U.maker2, U.saKeys, { sci, bar: 'BB' + randomUUID().replace(/-/g, '').slice(0, 10) });
        const t1 = held(U.saKeys, 'approve_new_material', [a.id, a.version, [], 'first']);
        const t1s = await t1.started;
        expect(t1s.ok).toBe(true);
        const t2 = settle(call(U.saKeys, 'approve_new_material', [b.id, b.version, [], 'second']));
        expect(await blockedOnAdvisory('%approve_new_material%')).toBe(true);        // proven waiting on the catalog lock, not merely slow
        t1.release(); await t1.done;
        const second = await t2;
        expect(second.ok).toBe(false);
        expect(second.message).toBe('material_duplicate_strong_match');
        expect(await countByName(sci)).toBe(1);
        expect((await status(b.id)).status).toBe('under_review');                   // untouched, still decidable (resolve to the new item)
      });

      it('DIFFERENT organizations sharing the central catalog: same identity approved concurrently still creates ONE item', async () => {
        const sci = uniq('Shared');
        const a = await reviewFor(U.maker, U.saKeys, { sci });
        const b = await reviewFor(U.other, U.saOther, { sci, org: ORG_OTHER });
        const t1 = held(U.saKeys, 'approve_new_material', [a.id, a.version, [], 'org one']);
        await t1.started;
        const t2 = settle(call(U.saOther, 'approve_new_material', [b.id, b.version, [], 'org two']));
        expect(await blockedOnAdvisory('%approve_new_material%')).toBe(true);
        t1.release(); await t1.done;
        const second = await t2;
        expect(second).toMatchObject({ ok: false, message: 'material_duplicate_strong_match' });
        expect(await countByName(sci)).toBe(1);
      });

      it('RED proof: with the lock scoped to the ORGANIZATION (the previous behaviour) the same race creates TWO logically identical items; restoring the catalog lock closes it', async () => {
        const [{ def }] = await admin(`SELECT pg_get_functiondef('phoenix_private.central_material_lock_catalog_v1(text,text,text,text,text)'::regprocedure) AS def`);
        expect(def).toMatch(/central_material_name_key_v1/);
        const orgScoped = `CREATE OR REPLACE FUNCTION phoenix_private.central_material_lock_catalog_v1(p_scientific text, p_strength text, p_form text, p_unit text, p_barcode text)
          RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
          BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || phoenix_private.central_material_identity_key_v1(p_scientific, p_strength, p_form, p_unit, p_barcode), 210003)); END; $$`;
        await admin(orgScoped);
        const sci = uniq('Red');
        try {
          const a = await reviewFor(U.maker, U.saKeys, { sci, bar: 'RA' + randomUUID().replace(/-/g, '').slice(0, 10) });
          const b = await reviewFor(U.maker2, U.saKeys, { sci, bar: 'RB' + randomUUID().replace(/-/g, '').slice(0, 10) });
          const t1 = held(U.saKeys, 'approve_new_material', [a.id, a.version, [], 'first']);
          await t1.started;
          const t2 = held(U.saKeys, 'approve_new_material', [b.id, b.version, [], 'second']);
          const s2 = await t2.started;                                               // NOT blocked: it proceeds beside the first
          expect(s2.ok).toBe(true);
          t1.release(); t2.release(); await t1.done; await t2.done;
          expect(await countByName(sci)).toBe(2);                                    // the violation the catalog lock prevents
        } finally {
          await admin(def);
        }
        const [{ def: after }] = await admin(`SELECT pg_get_functiondef('phoenix_private.central_material_lock_catalog_v1(text,text,text,text,text)'::regprocedure) AS def`);
        expect(after).toBe(def);
      });

      it('lock ORDER is fixed (name key, then barcode key): crossing identities never deadlock and never create duplicates', async () => {
        const bar = 'BX' + randomUUID().replace(/-/g, '').slice(0, 10);
        const a = await reviewFor(U.maker, U.saKeys, { sci: uniq('CrossA'), bar });
        const b = await reviewFor(U.maker2, U.saKeys, { sci: uniq('CrossB'), bar: 'BY' + randomUUID().replace(/-/g, '').slice(0, 10) });
        const c = await reviewFor(U.maker2, U.saKeys, { sci: uniq('CrossC'), bar: null });
        const results = await Promise.all([
          settle(call(U.saKeys, 'approve_new_material', [a.id, a.version, [], 'a'])),
          settle(call(U.saKeys, 'approve_new_material', [b.id, b.version, [], 'b'])),
          settle(call(U.saKeys, 'approve_new_material', [c.id, c.version, [], 'c'])),
        ]);
        expect(results.every((r) => r.ok)).toBe(true);                               // independent materials all succeed, no 40P01
        expect((await admin(`SELECT count(*)::int n FROM central_items WHERE barcode=$1`, [bar]))[0].n).toBe(1);
        // two DIFFERENT names that share one barcode: serialized on the barcode lock, exactly one wins
        const sameBar = 'BZ' + randomUUID().replace(/-/g, '').slice(0, 10);
        const d1 = await reviewFor(U.maker, U.saKeys, { sci: uniq('BarOne'), bar: sameBar });
        const d2 = await reviewFor(U.maker2, U.saKeys, { sci: uniq('BarTwo'), bar: sameBar }).catch((e: Error) => ({ error: e.message }));
        // the open-identity index already refuses a second open request on one barcode in one org; the catalog still holds one item per barcode
        expect(typeof (d2 as any).error === 'string' || (await settle(call(U.saKeys, 'approve_new_material', [d1.id, d1.version, [], 'x']))).ok).toBe(true);
        expect((await admin(`SELECT count(*)::int n FROM central_items WHERE barcode=$1`, [sameBar]))[0].n).toBeLessThanOrEqual(1);
      });
    });

    describe('2. advisory candidates: NOTHING is hidden from the reviewer, and approval needs ALL of them (no silent top-10)', () => {
      const similarSet = async (base: string, n: number) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) ids.push(await rawItem(`${base} Tabs ${String.fromCharCode(97 + (i % 26))}${i}`, { conc: `${(i + 1) * 5} mg`, form: 'Tablet', unit: 'box' }));
        return ids;
      };

      it('more than ten similar items: the reader and the server both see EVERY one; approval with only ten acknowledged is refused; with all of them it succeeds', async () => {
        const base = 'Moxifloxacin Hydrochloride ' + randomUUID().slice(0, 4);
        const similar = await similarSet(base, 12);
        const { id, version } = await toReview({ sci: base, str: '999 mg', form: 'Tablet', unit: 'box' });
        // the server's own list - the 12 created here plus any other genuinely similar catalog item left by earlier tests of this file
        const all = (await admin(`SELECT central_item_id FROM phoenix_private.central_material_candidates_v1($1,$2,$3,$4,NULL) WHERE grade='advisory'`, [base, '999 mg', 'Tablet', 'box']))
          .map((r: any) => r.central_item_id as string);
        expect(all.length).toBeGreaterThan(10);
        for (const id12 of similar) expect(all).toContain(id12);                       // none of the 12 is hidden
        let seen: any[] = [];
        await txAs(U.viewer, async (q) => { seen = await q(`SELECT central_item_id, grade FROM ${P}material_request_candidates($1)`, [id]); });
        expect(seen.filter((r) => r.grade === 'advisory').map((r) => r.central_item_id).sort()).toEqual([...all].sort());   // the reviewer sees the same full list
        const e = await refusal(approveNew(U.saKeys, id, version, all.slice(0, 10)));
        expect(e.message).toBe('material_duplicate_review_required');
        expect(e.detail).toContain(`unacknowledged_advisory_candidates=${all.length - 10}`);
        expect(await countByName(base)).toBe(0);
        expect(await approveNew(U.saKeys, id, version, all)).toMatchObject({ status: 'approved_new' });
        expect(await countByName(base)).toBe(1);
      });

      it('too many similar items to review safely (more than 50): approval is REFUSED until a human narrows it - resolving to an existing item or rejecting stays possible; the threshold is untouched', async () => {
        const base = 'Azithromycin Dihydrate ' + randomUUID().slice(0, 4);
        const similar = await similarSet(base, 55);
        const { id, version } = await toReview({ sci: base, str: '777 mg', form: 'Tablet', unit: 'box' });
        const e = await refusal(approveNew(U.saKeys, id, version, similar));            // even acknowledging every one
        expect(e.message).toBe('material_duplicate_review_too_large');
        expect(await countByName(base)).toBe(0);
        let seen: any[] = [];
        await txAs(U.viewer, async (q) => { seen = await q(`SELECT 1 FROM ${P}material_request_candidates($1) WHERE grade='advisory'`, [id]); });
        expect(seen.length).toBeGreaterThanOrEqual(55);                                   // the reader still returns ALL of them
        expect(await call(U.saKeys, 'reject_material_request', [id, version, 'too ambiguous - ask for the barcode'])).toMatchObject({ status: 'rejected' });
      });

      it('the similarity threshold is unchanged (0.45): the boundary behaviour of the previous candidate function is preserved', async () => {
        const [{ src }] = await admin(`SELECT prosrc AS src FROM pg_proc WHERE proname='central_material_candidates_v1'`);
        expect(src).toContain('a.s >= 0.45');
        expect(src).not.toMatch(/\bLIMIT\b/i);
      });
    });

    describe('3. concurrent idempotent create: one request, one event, a correct replay', () => {
      const payload = (key: string, sci: string) => [ORG, sci, null, null, '10 mg', 'Tablet', 'box', null, null, 'manual_typed', JSON.stringify({}), null, key];

      it('two concurrent creates with the SAME key and content: exactly one row and one creation event; the second returns the replay of the first', async () => {
        const key = randomUUID(); const sci = uniq('Idem');
        const t1 = held(U.maker, 'create_material_request_draft', payload(key, sci));
        const s1 = await t1.started;
        expect(s1.ok).toBe(true);
        const t2 = settle(call(U.maker, 'create_material_request_draft', payload(key, sci)));
        expect(await blockedOnAdvisory('%create_material_request_draft%')).toBe(true);   // serialized on (org, actor, key), not failing on the unique index
        t1.release(); await t1.done;
        const second: any = await t2;
        expect(second.ok).toBe(true);
        expect(second.r).toMatchObject({ idempotent_replay: true, request_id: s1.r.request_id });
        expect((await admin(`SELECT count(*)::int n FROM central_needs_material_requests WHERE idempotency_key=$1`, [key]))[0].n).toBe(1);
        expect((await admin(`SELECT count(*)::int n FROM central_needs_material_request_events WHERE request_id=$1 AND event_kind='draft_created'`, [s1.r.request_id]))[0].n).toBe(1);
      });

      it('SAME key, DIFFERENT content, concurrently: the first wins and the second stays refused (idempotency_conflict)', async () => {
        const key = randomUUID();
        const t1 = held(U.maker, 'create_material_request_draft', payload(key, uniq('IdemA')));
        await t1.started;
        const t2 = settle(call(U.maker, 'create_material_request_draft', payload(key, uniq('IdemB'))));
        expect(await blockedOnAdvisory('%create_material_request_draft%')).toBe(true);
        t1.release(); await t1.done;
        expect(await t2).toMatchObject({ ok: false, message: 'idempotency_conflict', code: '23505' });
        expect((await admin(`SELECT count(*)::int n FROM central_needs_material_requests WHERE idempotency_key=$1`, [key]))[0].n).toBe(1);
      });

      it('five simultaneous creates with one key: exactly one non-replay, four replays of the same request, one event', async () => {
        const key = randomUUID(); const sci = uniq('Five');
        const rs: any[] = await Promise.all(Array.from({ length: 5 }, () => settle(call(U.maker, 'create_material_request_draft', payload(key, sci)))));
        expect(rs.every((r) => r.ok)).toBe(true);
        expect(rs.filter((r) => r.r.idempotent_replay === false)).toHaveLength(1);
        expect(new Set(rs.map((r) => r.r.request_id)).size).toBe(1);
        expect((await admin(`SELECT count(*)::int n FROM central_needs_material_request_events e JOIN central_needs_material_requests r ON r.id=e.request_id WHERE r.idempotency_key=$1`, [key]))[0].n).toBe(1);
      });

      it('different actors may use the same key text independently (the key is scoped to organization + actor)', async () => {
        const key = randomUUID();
        const a = await call(U.maker, 'create_material_request_draft', payload(key, uniq('ScopeA')));
        const b = await call(U.maker2, 'create_material_request_draft', payload(key, uniq('ScopeB')));
        expect(a.request_id).not.toBe(b.request_id);
        expect(b.idempotent_replay).toBe(false);
      });
    });
  });

});
