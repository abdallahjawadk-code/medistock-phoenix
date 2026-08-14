/**
 * 183 / 168 · CREATION-vs-REPLENISHMENT MATRIX PARITY — dynamic proof.
 *
 * The defect class R1.2C exists to close is DRIFT: 168/180 refuse to replenish
 * certain emergency-outlet shapes at run time, while (before 183) nothing
 * refused to CREATE them. An outlet born into such a shape exists, reports as
 * operational, and can never be served.
 *
 * 183 deliberately does NOT rewrite phoenix_replenish_emergency_outlet. A second
 * author of one rule is the risk, not the fix. So the safety property is not
 * "183 is correct" but "183 and 168 AGREE", and it has to be measured rather
 * than asserted — which is what this file does, for all ten reachable
 * (institution class × point type × clinical context) combinations.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TWO RIGS
 * ─────────────────────────────────────────────────────────────────────────────
 * The replenishment verdict cannot be measured on the current chain: 181 and
 * 183 together make every illegal destination impossible to create as ACTIVE,
 * and 168 requires an active destination. That unreachability IS the fix — but
 * it would leave the parity claim untestable if measured there.
 *
 * So the two columns are measured where each is meaningful:
 *
 *   REPLENISHMENT · on a 001->180 rig. No topology write boundary exists yet,
 *     so all ten shapes are creatable and 168's own matrix answers for itself,
 *     independently of anything 181 or 183 did.
 *   CREATION      · on the full 001->183 chain, through a real INSERT.
 *
 * A disagreement in either direction fails this file, which is the signal the
 * R1.2C brief calls HOLD — 183/168 MATRIX DIVERGENCE.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(183500000000 + (seq += 1))}`;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

const ORG_HOSP = uid(), ORG_SPEC = uid(), ORG_SECTOR = uid();
const WH_HOSP = uid(), WH_SPEC = uid(), DEP_A = uid(), SECTOR_MAIN = uid();
const FAC_A = uid();

type Klass = 'hospital' | 'specialized_center' | 'health_sector';

interface Case {
  klass: Klass;
  type: 'crash_cabinet' | 'rescue_cart';
  clinical: 'emergency' | 'non_emergency';
  creation: 'legal' | 'illegal';
  replenishment: 'legal' | 'illegal';
}

/**
 * THE TEN CASES. Written out longhand, in the R1.2C brief's own order, so the
 * table can be read against the brief line by line rather than derived from a
 * rule — a derived table would agree with a wrong rule.
 */
const CASES: Case[] = [
  { klass: 'hospital',           type: 'crash_cabinet', clinical: 'non_emergency', creation: 'legal',   replenishment: 'legal' },
  { klass: 'hospital',           type: 'crash_cabinet', clinical: 'emergency',     creation: 'illegal', replenishment: 'illegal' },
  { klass: 'hospital',           type: 'rescue_cart',   clinical: 'emergency',     creation: 'legal',   replenishment: 'legal' },
  { klass: 'hospital',           type: 'rescue_cart',   clinical: 'non_emergency', creation: 'illegal', replenishment: 'illegal' },
  { klass: 'specialized_center', type: 'crash_cabinet', clinical: 'non_emergency', creation: 'legal',   replenishment: 'legal' },
  { klass: 'specialized_center', type: 'crash_cabinet', clinical: 'emergency',     creation: 'illegal', replenishment: 'illegal' },
  { klass: 'specialized_center', type: 'rescue_cart',   clinical: 'emergency',     creation: 'illegal', replenishment: 'illegal' },
  { klass: 'health_sector',      type: 'crash_cabinet', clinical: 'emergency',     creation: 'legal',   replenishment: 'legal' },
  { klass: 'health_sector',      type: 'crash_cabinet', clinical: 'non_emergency', creation: 'illegal', replenishment: 'illegal' },
  { klass: 'health_sector',      type: 'rescue_cart',   clinical: 'emergency',     creation: 'illegal', replenishment: 'illegal' },
];

const label = (c: Case) => `${c.klass} · ${c.type} · ${c.clinical}`;

const ORG_OF: Record<Klass, string> = {
  hospital: ORG_HOSP, specialized_center: ORG_SPEC, health_sector: ORG_SECTOR,
};
const WAREHOUSE_OF: Record<Klass, string> = {
  hospital: WH_HOSP, specialized_center: WH_SPEC, health_sector: DEP_A,
};

/** Every refusal 168's Shape H/I matrix can raise — and nothing else. */
const TOPOLOGY_REFUSALS = new RegExp([
  'health_center_rescue_cart_forbidden',
  'health_center_crash_cabinet_requires_emergency',
  'rescue_cart_requires_hospital',
  'rescue_cart_requires_emergency_context',
  'crash_cabinet_requires_non_emergency_context',
  'unsupported_institution_class_for_route',
  'destination_must_be_emergency_outlet',
  'destination_clinical_location_kind_required',
].join('|'));

/**
 * The shared organization/warehouse/facility fixture. Identical on both rigs so
 * the two columns are measured against the same topology, never against two
 * subtly different worlds.
 *
 * It is deliberately the CANONICAL R1.1 sector shape — one facility-less sector
 * main plus one facility-bound centre depot — even on the pre-181 rig, where
 * nothing asserts it. On the full chain 181's DEFERRED main-presence constraint
 * trigger fires at the end of this statement, so the main cannot be added
 * afterwards; making both rigs share the finished shape keeps the two columns
 * comparable instead of trading one difference for another.
 */
const FIXTURE = `
  INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
    ('${ORG_HOSP}',  'HP','مستشفى','r12cp-h','care_institution','hospital','active'),
    ('${ORG_SPEC}',  'SP','تخصصي','r12cp-s','care_institution','specialized_center','active'),
    ('${ORG_SECTOR}','QP','قطاع',  'r12cp-q','care_institution','health_sector','active');

  INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
    ('${FAC_A}','${ORG_SECTOR}','primary_health_center','A','أ','active');

  INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
    ('${WH_HOSP}',    '${ORG_HOSP}',  'HW','مخزن','institution',NULL,true,'active'),
    ('${WH_SPEC}',    '${ORG_SPEC}',  'SW','مخزن ت','institution',NULL,true,'active'),
    ('${SECTOR_MAIN}','${ORG_SECTOR}','Sector Main','رئيسي','institution',NULL,true,'active'),
    ('${DEP_A}',      '${ORG_SECTOR}','DA','مذخر أ','institution','${FAC_A}',false,'active');`;

// ════════════════════════════════════════════════════════════════════════════
// COLUMN 1 — REPLENISHMENT, on a 001->180 rig where every shape is creatable.
// ════════════════════════════════════════════════════════════════════════════
run('168/180 · the replenishment matrix, measured on a pre-181 chain', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const measured = new Map<string, 'legal' | 'illegal'>();

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  beforeAll(async () => {
    // 001->180: 164's routing foundation and 168/180's replenishment RPC are
    // present; 181's outlet topology guard and 183's matrix are NOT.
    rig = await buildRig({ upTo: 180 });
    await asAdmin(FIXTURE);
    // The sector main 181 would later require does not exist yet and is not
    // needed: nothing before 181 asserts a sector's warehouse shape.
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('the chain really is pre-181/183 — no topology write boundary exists', async () => {
    const r = await asAdmin(`
      SELECT to_regprocedure('public.phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text)') IS NULL AS no183,
             NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                          WHERE c.relname='distribution_points'
                            AND t.tgname='distribution_points_health_sector_topology_trg') AS no181,
             to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NOT NULL AS has168`);
    expect(r.rows[0]).toEqual({ no183: true, no181: true, has168: true });
  });

  for (const c of CASES) {
    it(`${label(c)} · replenishment is ${c.replenishment}`, async () => {
      const org = ORG_OF[c.klass];
      const warehouse = WAREHOUSE_OF[c.klass];

      // Source pharmacy and destination emergency outlet, both ACTIVE, in the
      // same organization and (for a health sector) the same facility — every
      // non-topology precondition 168 checks is deliberately satisfied, so the
      // only thing left that can answer is the matrix.
      const src = (await asAdmin(
        `INSERT INTO distribution_points
           (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,'SRC','مصدر','pharmacy','active','non_emergency') RETURNING id`,
        [warehouse, org])).rows[0].id;
      const dst = (await asAdmin(
        `INSERT INTO distribution_points
           (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,'DST','هدف',$3,'active',$4) RETURNING id`,
        [warehouse, org, c.type, c.clinical])).rows[0].id;

      // The route is INSERTed directly rather than through
      // phoenix_upsert_outlet_replenishment_route, because that writer (164)
      // enforces this same matrix and would refuse the illegal pairs before
      // 168 ever got to answer. Its agreement is asserted separately below.
      const route = (await asAdmin(
        `INSERT INTO outlet_replenishment_routes
           (organization_id, source_point_id, destination_point_id,
            source_point_type, destination_point_type, is_active)
         VALUES ($1,$2,$3,'pharmacy',$4,true) RETURNING id`,
        [org, src, dst, c.type])).rows[0].id;

      const message = await rejects(() => rig.asUser(
        rig.superAdminId,
        (x: any) => x.query(
          `SELECT public.phoenix_replenish_emergency_outlet($1,$2,$3,$4,NULL,'R1.2C parity')`,
          [randomUUID(), route, randomUUID(), 1]),
        { commit: false },
      ));

      if (c.replenishment === 'illegal') {
        expect(message, `${label(c)} must be refused by 168's matrix`).toMatch(TOPOLOGY_REFUSALS);
        measured.set(label(c), 'illegal');
      } else {
        // A legal shape passes the WHOLE matrix and stops at 180's
        // initial-first gate — the next statement after it. Reaching that gate
        // is precisely the evidence that no topology rule objected.
        expect(message, `${label(c)} must pass 168's matrix`)
          .toMatch(/initial_provisioning_required_before_replenishment/);
        expect(message).not.toMatch(TOPOLOGY_REFUSALS);
        measured.set(label(c), 'legal');
      }
    });
  }

  it('all ten replenishment verdicts match the declared table', () => {
    expect([...measured.entries()].sort()).toEqual(
      CASES.map(c => [label(c), c.replenishment] as [string, string]).sort(),
    );
  });

  it("164's route writer agrees with 168 on every case", async () => {
    // A third statement of the same matrix already exists in the route writer.
    // It must not be a fourth opinion: an illegal pair is refused there too.
    for (const c of CASES) {
      const org = ORG_OF[c.klass];
      const warehouse = WAREHOUSE_OF[c.klass];
      const src = (await asAdmin(
        `INSERT INTO distribution_points
           (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,'RSRC','مصدر','pharmacy','active','non_emergency') RETURNING id`,
        [warehouse, org])).rows[0].id;
      const dst = (await asAdmin(
        `INSERT INTO distribution_points
           (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,'RDST','هدف',$3,'active',$4) RETURNING id`,
        [warehouse, org, c.type, c.clinical])).rows[0].id;

      const call = () => rig.asUser(
        rig.superAdminId,
        (x: any) => x.query(
          `SELECT public.phoenix_upsert_outlet_replenishment_route(NULL,$1,$2,true,NULL)`, [src, dst]),
        { commit: false },
      );

      if (c.replenishment === 'illegal') {
        expect(await rejects(call), `${label(c)} route`).toMatch(TOPOLOGY_REFUSALS);
      } else {
        const r = await call();
        expect(r.rowCount, `${label(c)} route`).toBe(1);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COLUMN 2 — CREATION, on the full 001->183 chain.
// ════════════════════════════════════════════════════════════════════════════
run('183 · the creation matrix, measured on the full chain', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const measured = new Map<string, 'legal' | 'illegal'>();

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(FIXTURE);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('the chain really is post-183 — the canonical validator governs the table', async () => {
    const r = await asAdmin(`
      SELECT to_regprocedure('public.phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text)') IS NOT NULL AS has183,
             (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
               WHERE c.relname='distribution_points' AND NOT t.tgisinternal
                 AND pg_get_triggerdef(t.oid) ILIKE '%topology%') AS topology_triggers`);
    expect(r.rows[0]).toEqual({ has183: true, topology_triggers: 1 });
  });

  for (const c of CASES) {
    it(`${label(c)} · creation is ${c.creation}`, async () => {
      const create = () => asAdmin(
        `INSERT INTO distribution_points
           (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,'C183','ع',$3,'active',$4) RETURNING id`,
        [WAREHOUSE_OF[c.klass], ORG_OF[c.klass], c.type, c.clinical]);

      if (c.creation === 'illegal') {
        const message = await rejects(create);
        // A refusal, and specifically a TOPOLOGY refusal — not a constraint
        // violation, a permission error or a missing fixture.
        expect(message, `${label(c)} must be refused by 183`).toMatch(
          /rescue_cart_requires_emergency_context|crash_cabinet_requires_non_emergency_context|specialized_center_rescue_cart_not_permitted|health_center_rescue_cart_not_permitted|health_center_crash_cabinet_requires_emergency_context|outlet_owner_institution_class_unsupported|pharmacy_department_authority_outlet_not_permitted/,
        );
        measured.set(label(c), 'illegal');
      } else {
        const r = await create();
        expect(r.rows[0].id, `${label(c)} must be admitted by 183`).toBeTruthy();
        measured.set(label(c), 'legal');
      }
    });
  }

  it('all ten creation verdicts match the declared table', () => {
    expect([...measured.entries()].sort()).toEqual(
      CASES.map(c => [label(c), c.creation] as [string, string]).sort(),
    );
  });

  // ── THE PARITY CLAIM ITSELF ───────────────────────────────────────────────
  it('PARITY · creation and replenishment agree on all ten cases', () => {
    // The declared table is the contract; both columns were measured against
    // the live database independently, above. This asserts the property the
    // whole file exists for — that the two columns are the SAME column.
    const disagreements = CASES
      .filter(c => c.creation !== c.replenishment)
      .map(label);
    expect(disagreements, 'HOLD — 183/168 MATRIX DIVERGENCE').toEqual([]);
  });

  it('PARITY · every shape 168 refuses to serve, 183 refuses to create', () => {
    for (const c of CASES) {
      if (c.replenishment === 'illegal') {
        expect(c.creation, `${label(c)} is servable-but-uncreatable or vice versa`).toBe('illegal');
      }
    }
  });

  it('PARITY · 183 creates no shape 168 cannot then serve', () => {
    // The direction that matters operationally: an outlet the database lets you
    // build must be one the replenishment corridor will actually top up.
    for (const c of CASES) {
      if (c.creation === 'legal') {
        expect(c.replenishment, `${label(c)} would be born unservable`).toBe('legal');
      }
    }
  });
});
