/**
 * 185 · R1.5-F2 MODEL CORRECTION M1 — corridor-aware warehouse return reference.
 *
 * WHAT M1 CLOSES
 *   069 keyed the external return reference ORGANIZATION-wide:
 *     wrr_src_org_number_uniq  UNIQUE (source_organization_id, btrim(return_number))
 *   which assumes one organization can hold at most ONE return corridor per
 *   reference. The canonical health-sector topology breaks that:
 *
 *     W0 central (PDA) --184 Branch A--> W1 Sector Main --Branch B--> W2 Depot
 *
 *   181 forces EVERY health-sector warehouse to warehouse_kind='institution',
 *   and 184's Branch B requires src.organization_id = dst.organization_id, so W1
 *   and W2 are necessarily in ONE organization. A recall reaching stock at both
 *   needs corridors W1->W0 and W2->W1 under ONE operator reference — and the old
 *   index made the second header structurally impossible (SQLSTATE 23505).
 *
 *   wrr_corridor_number_uniq now keys on the CANONICAL CORRIDOR IDENTITY:
 *     (source_warehouse_id, destination_warehouse_id,
 *      COALESCE(route_id, nil-uuid), btrim(return_number))
 *
 *   The operator's return_number is never rewritten — no suffixes, no generated
 *   child references.
 *
 * SCOPE: representability only. F2 downstream propagation is NOT implemented
 * here; these tests build the downstream headers explicitly to prove the model
 * can express them.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_PDA = '00000000-0000-0000-0000-0000001850a1';  // pharmacy department authority
const ORG_SEC = '00000000-0000-0000-0000-0000001850a2';  // ONE health sector
const ORG_OTH = '00000000-0000-0000-0000-0000001850a3';  // an unrelated hospital
const W0      = '00000000-0000-0000-0000-0000001850b1';  // central
const W1      = '00000000-0000-0000-0000-0000001850b2';  // sector main   (facility-less)
const W2      = '00000000-0000-0000-0000-0000001850b3';  // centre depot  (facility-bound)
const W3      = '00000000-0000-0000-0000-0000001850b4';  // second centre depot
const WOTH    = '00000000-0000-0000-0000-0000001850b5';  // other org's warehouse
const FAC     = '00000000-0000-0000-0000-0000001850c1';
const FAC2    = '00000000-0000-0000-0000-0000001850c2';
const ROUTE   = '00000000-0000-0000-0000-0000001850d1';  // W0 -> WOTH, routed corridor
const ACTOR   = '00000000-0000-0000-0000-0000001850e1';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;
const NIL = '00000000-0000-0000-0000-000000000000';

run('185 · R1.5-F2-M1 corridor-aware return reference (001->185 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);
  const asSuper = <T>(fn: (c: any) => Promise<T>) =>
    rig.asUser(rig.superAdminId, fn, { commit: true }) as Promise<T>;
  const asUser = <T>(id: string, fn: (c: any) => Promise<T>) =>
    rig.asUser(id, fn, { commit: true }) as Promise<T>;
  const admin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const one = async (sql: string, params: any[] = []) => (await admin(sql, params)).rows[0];
  const rows = async (sql: string, params: any[] = []) => (await admin(sql, params)).rows;
  const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
    throw new Error('expected a rejection but the call succeeded');
  };

  /** Insert a return header directly — this suite tests REPRESENTABILITY. */
  const header = (srcWh: string, srcOrg: string, dstWh: string, dstOrg: string,
                  number: string, routeId: string | null = null) =>
    admin(
      `INSERT INTO warehouse_return_requests
         (route_id, source_warehouse_id, source_organization_id,
          destination_warehouse_id, destination_organization_id,
          return_number, status, requested_by_side, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft','sender',$7) RETURNING id`,
      [routeId, srcWh, srcOrg, dstWh, dstOrg, number, rig.superAdminId]);

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_PDA}','PDA','دائرة','m1-pda','pharmacy_department_authority',NULL),
        ('${ORG_SEC}','Sector','قطاع','m1-sec','care_institution','health_sector'),
        ('${ORG_OTH}','Other','مستشفى','m1-oth','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,code,status) VALUES
        ('${FAC}','${ORG_SEC}','primary_health_center','HC1','مركز','m1-hc1','active'),
        ('${FAC2}','${ORG_SEC}','subordinate_health_center','HC2','مركز','m1-hc2','active')
        ON CONFLICT (id) DO NOTHING;`);
      // 181: every health-sector warehouse is warehouse_kind='institution'; the
      // facility-less one is the Sector Main, the facility-bound ones are depots.
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id,is_main) VALUES
        ('${W0}','${ORG_PDA}','Central','مركزي','active','central','m1-w0',NULL,false),
        ('${W1}','${ORG_SEC}','SectorMain','رئيسي','active','institution','m1-w1',NULL,true),
        ('${W2}','${ORG_SEC}','Depot1','مستودع','active','institution','m1-w2','${FAC}',false),
        ('${W3}','${ORG_SEC}','Depot2','مستودع','active','institution','m1-w3','${FAC2}',false),
        ('${WOTH}','${ORG_OTH}','OtherWh','مخزن','active','institution','m1-woth',NULL,true)
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
        VALUES ('${ROUTE}','${W0}','${WOTH}','central','institution',true) ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${ACTOR}','m1-actor@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_PDA}' WHERE id='${ACTOR}';`);
      await c.query(`INSERT INTO profile_permission_overrides (profile_id,permission_key,allowed)
        VALUES ('${ACTOR}','warehouse_transfer.recall',true)
        ON CONFLICT (profile_id,permission_key) DO UPDATE SET allowed=true;`);
    });

    // 165 refuses a return header on a corridor that never carried a forward
    // transfer ('no_direct_forward_provenance_between_warehouses'), enforced on
    // the table itself. Every corridor these tests write a header for therefore
    // needs REAL forward movement first. Seeded once, on its own material, so it
    // cannot perturb the custody arithmetic any individual test asserts.
    const seed = uniq('m1-seed');
    const s0 = await directHop(W0, ORG_SEC, W1, 30, seed, null);   // W0 -> W1
    await directHop(W1, ORG_SEC, W2, 10, seed, s0.stockId);        // W1 -> W2
    await directHop(W1, ORG_SEC, W3, 10, seed, s0.stockId);        // W1 -> W3
    await directHop(W0, ORG_OTH, WOTH, 10, seed, null);            // W0 -> WOTH (direct)
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** One DIRECT supply hop driven through the genuine request/approve/send/receive chain. */
  async function directHop(src: string, dstOrg: string, dst: string, qty: number,
                           material: string, fromStockId: string | null) {
    return asSuper(async (c: any) => {
      let stockId = fromStockId;
      if (!stockId) {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), src, material, qty, true, true, 0,
          null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
        ]);
        stockId = rc.warehouse_stock_id;
      }
      const req = await call(c, 'phoenix_create_direct_warehouse_transfer_request',
        [src, dstOrg, dst, uniq('DREQ'), null]);
      const reqId = req.transfer_request_id ?? req.id;
      const ln = await call(c, 'phoenix_add_warehouse_transfer_request_line',
        [reqId, material, qty, null, null, null, null, null]);
      const lnId = ln.transfer_request_line_id ?? ln.id;
      await call(c, 'phoenix_submit_warehouse_transfer_request', [reqId]);
      await call(c, 'phoenix_review_warehouse_transfer_request',
        [reqId, JSON.stringify([{ line_id: lnId, approved_quantity: qty }])]);
      const s = await call(c, 'phoenix_send_direct_warehouse_transfer_line',
        [randomUUID(), reqId, stockId, qty, uniq('DTR'), lnId, null, null]);
      const r = await call(c, 'phoenix_receive_warehouse_transfer_line',
        [randomUUID(), s.transfer_line_id, qty, null, null]);
      return { transferLineId: s.transfer_line_id as string, stockId: r.warehouse_stock_id as string };
    });
  }

  // ── M1-G.1. The blocker the whole model correction exists for ──────────────
  it('M1-1. canonical health sector: ONE reference, TWO corridors, ONE organization', async () => {
    const material = uniq('m1-sector');
    // W0 -> W1 (Branch A), then W1 -> W2 (Branch B). Custody stays at BOTH.
    const hop1 = await directHop(W0, ORG_SEC, W1, 100, material, null);
    const hop2 = await directHop(W1, ORG_SEC, W2, 60, material, hop1.stockId);

    // The lineage edge F2 will walk, and real custody at both holders.
    const l2 = await one(
      `SELECT source_warehouse_stock_id AS src FROM warehouse_transfer_lines WHERE id=$1`,
      [hop2.transferLineId]);
    expect(l2.src).toBe(hop1.stockId);
    expect((await one(`SELECT on_hand_quantity AS q FROM warehouse_stock WHERE id=$1`, [hop1.stockId])).q).toBe(40);
    expect((await one(`SELECT on_hand_quantity AS q FROM warehouse_stock WHERE id=$1`, [hop2.stockId])).q).toBe(60);

    // Both holders sit in ONE organization — this is what 069's index could not model.
    const orgs = await rows(`SELECT DISTINCT organization_id AS o FROM warehouses WHERE id IN ($1,$2)`, [W1, W2]);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].o).toBe(ORG_SEC);

    // ONE operator reference, the two corridors the recall needs. Pre-M1 the
    // second header raised 23505 on wrr_src_org_number_uniq; the corridor-aware
    // key makes it representable, and R1.5-F2 now materializes it for real — one
    // authorized root recall reaches BOTH current holders.
    const REF = uniq('RECALL-X');
    const first = await asUser(ACTOR, (c: any) =>
      call(c, 'phoenix_recall_warehouse_transfer_line', [hop1.transferLineId, REF, null]));
    expect(first.obligations_created).toBe(2);          // W1 -> W0 and W2 -> W1

    // ORDER BY created_at ALONE IS A TIE. One authorized recall materializes every
    // corridor inside ONE transaction, and created_at defaults to now(), which is
    // transaction-stable — so all of this reference's headers carry the SAME
    // timestamp and their relative order is whatever the executor happens to
    // return. The canonical corridor fields are the deterministic key; created_at
    // stays first so the intent (creation order, when it differs) still reads.
    const hdrs = await rows(
      `SELECT source_warehouse_id AS sw, destination_warehouse_id AS dw, source_organization_id AS so
         FROM warehouse_return_requests WHERE btrim(return_number)=$1
        ORDER BY created_at, source_warehouse_id, destination_warehouse_id`, [REF]);
    expect(hdrs).toHaveLength(2);
    expect(hdrs.map((h: any) => [h.sw, h.dw])).toEqual([[W1, W0], [W2, W1]]);
    // Same organization on both, same external reference, different corridors.
    expect(new Set(hdrs.map((h: any) => h.so))).toEqual(new Set([ORG_SEC]));
  });

  // ── M1-G.2. Same corridor + same reference is still ONE document ───────────
  it('M1-2. same corridor + same reference => ONE header, never two', async () => {
    const REF = uniq('SAME-CORR');
    await header(W1, ORG_SEC, W0, ORG_PDA, REF, null);
    const dup = await rejects(() => header(W1, ORG_SEC, W0, ORG_PDA, REF, null));
    expect(dup).toMatch(/wrr_corridor_number_uniq/);
    expect((await rows(
      `SELECT id FROM warehouse_return_requests WHERE btrim(return_number)=$1`, [REF]))).toHaveLength(1);
  });

  // ── M1-G.3. Same org, same reference, different corridor ──────────────────
  it('M1-3. same organization + same reference + different corridor => separate headers', async () => {
    const REF = uniq('ORG-TWO-CORR');
    await header(W2, ORG_SEC, W1, ORG_SEC, REF, null);   // depot 1 -> sector main
    await header(W3, ORG_SEC, W1, ORG_SEC, REF, null);   // depot 2 -> sector main
    const hdrs = await rows(
      `SELECT source_warehouse_id AS sw FROM warehouse_return_requests
        WHERE btrim(return_number)=$1 AND source_organization_id=$2`, [REF, ORG_SEC]);
    expect(new Set(hdrs.map((h: any) => h.sw))).toEqual(new Set([W2, W3]));
  });

  // ── M1-G.4. Exact duplicate, including the DIRECT (NULL route) case ───────
  it('M1-4. an exact corridor duplicate is refused — NULL route does not escape the key', async () => {
    // A raw nullable route_id in a UNIQUE index compares NULLs as DISTINCT, so
    // this pair would both insert. COALESCE to the nil uuid is what stops it.
    const REF = uniq('DIRECT-DUP');
    await header(W2, ORG_SEC, W1, ORG_SEC, REF, null);
    expect(await rejects(() => header(W2, ORG_SEC, W1, ORG_SEC, REF, null)))
      .toMatch(/wrr_corridor_number_uniq/);

    // And a routed header on the SAME endpoints is a different channel, so it is
    // legitimately a separate document.
    const REF2 = uniq('ROUTED-VS-DIRECT');
    await header(WOTH, ORG_OTH, W0, ORG_PDA, REF2, null);          // direct
    await header(WOTH, ORG_OTH, W0, ORG_PDA, REF2, ROUTE);         // routed
    expect((await rows(
      `SELECT id FROM warehouse_return_requests WHERE btrim(return_number)=$1`, [REF2]))).toHaveLength(2);
    // ...but the routed one is still unique per route.
    expect(await rejects(() => header(WOTH, ORG_OTH, W0, ORG_PDA, REF2, ROUTE)))
      .toMatch(/wrr_corridor_number_uniq/);
  });

  // ── M1-G.5. Normalization is identical on both sides of the key ───────────
  it('M1-5. btrim normalization is shared by the index, the CHECK and the RPCs', async () => {
    // wrr_number_chk already forces stored values to be trimmed, so an untrimmed
    // reference can never reach the table at all...
    const raw = uniq('NORM');
    expect(await rejects(() => header(W2, ORG_SEC, W1, ORG_SEC, `  ${raw}  `, null)))
      .toMatch(/wrr_number_chk/);
    // ...and the RPCs normalize with NULLIF(btrim(...), '') before insert, so a
    // padded operator entry resolves onto the SAME corridor+reference document.
    const material = uniq('m1-norm');
    const hop = await directHop(W0, ORG_OTH, WOTH, 10, material, null);
    const a = await asUser(ACTOR, (c: any) =>
      call(c, 'phoenix_recall_warehouse_transfer_line', [hop.transferLineId, raw, null]));
    expect(a.obligations_created).toBe(1);
    for (const padded of [` ${raw}`, `${raw} `, `  ${raw}  `]) {
      const again = await asUser(ACTOR, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer_line', [hop.transferLineId, padded, null]));
      expect(again.obligations_reused).toBe(1);
      expect(again.obligations_created).toBe(0);
      expect(again.return_number).toBe(raw);
    }
    expect((await rows(
      `SELECT id FROM warehouse_return_requests WHERE btrim(return_number)=$1`, [raw]))).toHaveLength(1);
  });

  // ── M1-G.6. Different organizations keep sharing one reference ────────────
  it('M1-6. different holder organizations may still share one external reference', async () => {
    const REF = uniq('MULTI-ORG');
    await header(W1, ORG_SEC, W0, ORG_PDA, REF, null);
    await header(WOTH, ORG_OTH, W0, ORG_PDA, REF, null);
    const hdrs = await rows(
      `SELECT source_organization_id AS so FROM warehouse_return_requests WHERE btrim(return_number)=$1`, [REF]);
    expect(new Set(hdrs.map((h: any) => h.so))).toEqual(new Set([ORG_SEC, ORG_OTH]));
  });

  // ── M1-G.7. Manual returns still behave ───────────────────────────────────
  it('M1-7. manual returns are unaffected: the RPC still creates, and its own duplicate still fails', async () => {
    const material = uniq('m1-manual');
    const hop = await directHop(W0, ORG_OTH, WOTH, 12, material, null);
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('00000000-0000-0000-0000-0000001850e2','m1-holder@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_OTH}' WHERE id='00000000-0000-0000-0000-0000001850e2';`);
      await c.query(`INSERT INTO profile_permission_overrides (profile_id,permission_key,allowed)
        VALUES ('00000000-0000-0000-0000-0000001850e2','warehouse_transfer.return_request',true)
        ON CONFLICT (profile_id,permission_key) DO UPDATE SET allowed=true;`);
    });
    const HOLDER = '00000000-0000-0000-0000-0000001850e2';
    const REF = uniq('MANUAL');
    const made = await asUser(HOLDER, async (c: any) => {
      const req = await call(c, 'phoenix_request_direct_warehouse_return', [WOTH, W0, REF, null]);
      const id = req.return_request_id ?? req.id;
      await call(c, 'phoenix_add_warehouse_return_request_line',
        [id, hop.transferLineId, 5, 'excess', 'm1-manual']);
      return id;
    });
    expect(made).toBeTruthy();
    // The same operator reference on the SAME corridor is still one document.
    expect(await rejects(() => asUser(HOLDER, (c: any) =>
      call(c, 'phoenix_request_direct_warehouse_return', [WOTH, W0, REF, null]))))
      .toMatch(/wrr_corridor_number_uniq/);
  });

  // ── M1-G.8. The rule itself, pinned structurally ──────────────────────────
  it('M1-8. the old organization-wide rule is gone and exactly one corridor rule exists', async () => {
    expect((await rows(
      `SELECT 1 FROM pg_class WHERE relname='wrr_src_org_number_uniq'`))).toHaveLength(0);

    const idx = await rows(
      `SELECT c.relname AS name, pg_get_indexdef(c.oid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indrelid='public.warehouse_return_requests'::regclass
          AND i.indisunique AND pg_get_indexdef(c.oid) LIKE '%btrim(return_number)%'`);
    expect(idx).toHaveLength(1);
    expect(idx[0].name).toBe('wrr_corridor_number_uniq');
    expect(idx[0].def).toContain('source_warehouse_id');
    expect(idx[0].def).toContain('destination_warehouse_id');
    expect(idx[0].def).toContain('COALESCE(route_id');
    expect(idx[0].def).toContain('btrim(return_number)');
    // the organization must not be a disambiguator again
    expect(idx[0].def).not.toContain('organization_id');
    // and route_id must never be keyed raw
    expect(idx[0].def.replace(/COALESCE\(route_id/g, '')).not.toContain('route_id');
    // it is a standalone index, not constraint-backed
    expect((await rows(
      `SELECT 1 FROM pg_constraint
        WHERE conindid=(SELECT oid FROM pg_class WHERE relname='wrr_corridor_number_uniq')`))).toHaveLength(0);
    // the direct-corridor sentinel cannot collide with a real route
    expect((await rows(
      `SELECT 1 FROM warehouse_supply_routes WHERE id=$1`, [NIL]))).toHaveLength(0);
  });

  it('M1-9. the obligation writer resolves its header on the SAME identity the index enforces', async () => {
    // R1.5-F2 moved header resolution into the shared obligation writer, so the
    // root receipt and every downstream receipt use one corridor key.
    const def = (await one(
      `SELECT pg_get_functiondef(
         'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure) AS d`)).d;
    // no organization-keyed lookup left
    expect(def).not.toContain('WHERE source_organization_id = v_transfer.destination_organization_id');
    expect(def).toContain('WHERE source_warehouse_id = v_transfer.destination_warehouse_id');
    expect(def).toContain('AND destination_warehouse_id = v_transfer.source_warehouse_id');
    expect(def).toContain(`COALESCE(route_id, '${NIL}'::uuid)`);
    expect(def).toContain('AND btrim(return_number) = v_number');
    // the corridor-scoped header lock that serializes two DIFFERENT selectors
    // converging on one corridor + reference
    expect(def).toContain('185002');
    // replay keys on the corridor too
    expect(def).toContain(`COALESCE(r.route_id, '${NIL}'::uuid)`);
    // public contract untouched
    const sig = await one(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='phoenix_recall_warehouse_transfer_line'`);
    expect(sig.args).toBe('p_original_transfer_line_id uuid, p_return_number text, p_notes text');
  });
});
