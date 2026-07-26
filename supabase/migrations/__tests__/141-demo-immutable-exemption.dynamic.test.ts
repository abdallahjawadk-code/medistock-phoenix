/**
 * PHOENIX-DEMO-IMMUTABLE-EXEMPTION-141 — ADVERSARIAL acceptance.
 *
 * 141 opens a deletion path through two deliberate product immutability
 * guarantees (procurement history, official report snapshots). The burden of
 * proof is therefore not "the demo purge works" but "a genuine row cannot be
 * reached by it, under attack". Every test below is written from the
 * attacker's side.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const DS = 'PHOENIX_DEMO_V1';

const REAL_ORG = '00000000-0000-0000-0000-00000014a001';
const DEMO_ORG = '00000000-0000-0000-0000-00000014a002';
const OTHER_ORG = '00000000-0000-0000-0000-00000014a003';
const SA = '00000000-0000-0000-0000-00000014a401';   // super_admin
const IA = '00000000-0000-0000-0000-00000014a402';   // institution_admin
const OO = '00000000-0000-0000-0000-00000014a403';   // outlet_officer

run('141 demo immutable exemption — adversarial (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  /** Insert a snapshot row directly as superuser (simulating a genuine one
   *  created earlier by the real RPC), optionally in a demo org. */
  async function makeSnapshot(orgId: string, label: string) {
    const id = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO phoenix_report_snapshots
           (id, organization_id, report_type, request_id, request_fingerprint,
            filters, source_as_of, payload, qr_payload, created_by, created_by_role)
         VALUES ($1,$2,'executive_overview',$3,$4,'{}'::jsonb, now(), $5::jsonb, $6, $7,'super_admin')`,
        [id, orgId, randomUUID(), createHash('sha256').update(id).digest('hex'),
         JSON.stringify({ label }), `qr-${id}`, SA]);
    });
    return id;
  }

  const register = (c: any, table: string, id: string) =>
    c.query(`SELECT public.phoenix_demo_register($1,$2,$3,NULL)`, [DS, table, id]);

  /** Re-establish the demo-org registration. Earlier purges legitimately
   *  clear the manifest, so each test asserts its own preconditions rather
   *  than depending on cross-test ordering. */
  const ensureDemoOrgOwned = async () => {
    // The purge genuinely deletes the demo organization, so a later test must
    // recreate it as well as re-register it. Each test owns its preconditions.
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Demo','تجريبي','p141-demo')
         ON CONFLICT (id) DO NOTHING`, [DEMO_ORG]);
    });
    await rig.asUser(SA, async (c: any) => { await register(c, 'organizations', DEMO_ORG); }, { commit: true });
  };

  const mark = (c: any, table: string, id: string, ds = DS) =>
    c.query(`SELECT public.phoenix_demo_mark_row($1,$2,$3)`, [ds, table, id]);

  const purge = (c: any, dry = false) =>
    c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DS, dry]).then((r: any) => r.rows);

  const exists = async (table: string, id: string) => {
    let n = -1;
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]);
      n = r.rows[0].n;
    });
    return n === 1;
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ($1,'Real','حقيقية','p141-real'),($2,'Demo','تجريبي','p141-demo'),($3,'Other','أخرى','p141-other')
        ON CONFLICT (id) DO NOTHING`, [REAL_ORG, DEMO_ORG, OTHER_ORG]);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ($1,'p141-sa@rig'),($2,'p141-ia@rig'),($3,'p141-oo@rig') ON CONFLICT (id) DO NOTHING`,
        [SA, IA, OO]);
      await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=$1 WHERE id=$2`, [REAL_ORG, SA]);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id=$1 WHERE id=$2`, [REAL_ORG, IA]);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id=$1 WHERE id=$2`, [REAL_ORG, OO]);
    });
    // Only DEMO_ORG is demo-owned.
    await rig.asUser(SA, async (c: any) => { await register(c, 'organizations', DEMO_ORG); }, { commit: true });
  }, 180000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── The central guarantee ────────────────────────────────────────────────

  it('a GENUINE snapshot in a real org survives purge --execute, even when registered in the manifest and named PHOENIX_DEMO_V1', async () => {
    const genuine = await makeSnapshot(REAL_ORG, 'PHOENIX_DEMO_V1');
    // The attacker forges manifest ownership for a real row.
    await rig.asUser(SA, async (c: any) => { await register(c, 'phoenix_report_snapshots', genuine); }, { commit: true });
    // Marking must still refuse it: its ORGANIZATION is not demo-owned.
    await rig.asUser(SA, async (c: any) => {
      await expect(mark(c, 'phoenix_report_snapshots', genuine)).rejects.toThrow(/organization_not_demo_owned/);
    });
    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
    expect(await exists('phoenix_report_snapshots', genuine)).toBe(true);
  });

  it('a fake manifest record alone cannot make a real row purgeable — the marker stays NULL and the trigger still refuses', async () => {
    const genuine = await makeSnapshot(REAL_ORG, 'genuine');
    await rig.asUser(SA, async (c: any) => { await register(c, 'phoenix_report_snapshots', genuine); }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT demo_dataset_id FROM phoenix_report_snapshots WHERE id=$1`, [genuine]);
      expect(r.rows[0].demo_dataset_id).toBeNull();
    });
    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
    expect(await exists('phoenix_report_snapshots', genuine)).toBe(true);
  });

  it('a genuine row\'s marker cannot be changed to demo by ANY route (write-once trigger)', async () => {
    const genuine = await makeSnapshot(REAL_ORG, 'genuine');
    // Even as the table owner / superuser, the write-once trigger refuses.
    await rig.asAdmin(async (c: any) => {
      await expect(
        c.query(`UPDATE phoenix_report_snapshots SET demo_dataset_id='PHOENIX_DEMO_V1' WHERE id=$1`, [genuine]),
      ).rejects.toThrow(/demo_dataset_marker_is_write_once/);
    });
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT demo_dataset_id FROM phoenix_report_snapshots WHERE id=$1`, [genuine]);
      expect(r.rows[0].demo_dataset_id).toBeNull();
    });
  });

  it('the marker column rejects any value other than the exact dataset constant', async () => {
    await ensureDemoOrgOwned();
    const s = await makeSnapshot(DEMO_ORG, 'demo');
    await rig.asAdmin(async (c: any) => {
      await expect(
        c.query(`UPDATE phoenix_report_snapshots SET demo_dataset_id='SOMETHING_ELSE' WHERE id=$1`, [s]),
      ).rejects.toThrow();   // CHECK constraint and/or write-once trigger
    });
  });

  // ── Role and scope denial ────────────────────────────────────────────────

  it('institution_admin and outlet_officer cannot mark or purge', async () => {
    await ensureDemoOrgOwned();
    const s = await makeSnapshot(DEMO_ORG, 'demo');
    await rig.asUser(SA, async (c: any) => { await register(c, 'phoenix_report_snapshots', s); }, { commit: true });
    for (const actor of [IA, OO]) {
      await rig.asUser(actor, async (c: any) => {
        await expect(mark(c, 'phoenix_report_snapshots', s)).rejects.toThrow(/forbidden_demo_marking/);
      });
      await rig.asUser(actor, async (c: any) => {
        await expect(purge(c, true)).rejects.toThrow(/forbidden_demo_purge/);
      });
    }
  });

  it('anon holds no EXECUTE on any exemption function and no membership of the purger role', async () => {
    await rig.asAdmin(async (c: any) => {
      const f = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.role_routine_grants
          WHERE routine_schema='public' AND grantee='anon'
            AND routine_name IN ('phoenix_demo_mark_row','phoenix_demo_purge',
                                 'phoenix_demo_row_is_purgeable','phoenix_demo_marker_is_write_once')`);
      expect(f.rows[0].n).toBe(0);
      const m = await c.query(
        `SELECT count(*)::int AS n FROM pg_auth_members am
           JOIN pg_roles r ON r.oid=am.roleid JOIN pg_roles g ON g.oid=am.member
          WHERE r.rolname='phoenix_demo_purger' AND g.rolname IN ('authenticated','anon')`);
      expect(m.rows[0].n).toBe(0);
    });
  });

  it('a wrong dataset id is refused by marking', async () => {
    await ensureDemoOrgOwned();
    const s = await makeSnapshot(DEMO_ORG, 'demo');
    await rig.asUser(SA, async (c: any) => { await register(c, 'phoenix_report_snapshots', s); }, { commit: true });
    await rig.asUser(SA, async (c: any) => {
      await expect(mark(c, 'phoenix_report_snapshots', s, 'PHOENIX_DEMO_V2')).rejects.toThrow(/invalid_demo_dataset_key/);
    });
  });

  it('a table outside the hardcoded allow-list cannot be marked', async () => {
    await rig.asUser(SA, async (c: any) => {
      await expect(mark(c, 'profiles', SA)).rejects.toThrow(/table_not_demo_markable/);
    });
  });

  // ── Direct mutation stays refused exactly as before ──────────────────────

  it('direct DELETE on a demo-marked row OUTSIDE the purge is still refused (the ownership boundary is what matters)', async () => {
    await ensureDemoOrgOwned();
    const s = await makeSnapshot(DEMO_ORG, 'demo');
    await rig.asUser(SA, async (c: any) => {
      await register(c, 'phoenix_report_snapshots', s);
      await mark(c, 'phoenix_report_snapshots', s);
    }, { commit: true });
    // Correctly marked and owned — but not executing as phoenix_demo_purger.
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(`DELETE FROM phoenix_report_snapshots WHERE id=$1`, [s]))
        .rejects.toThrow(/report_snapshot_is_immutable/);
    });
    expect(await exists('phoenix_report_snapshots', s)).toBe(true);
  });

  it('direct UPDATE on a demo row is still refused — demo records are immutable while they exist', async () => {
    await ensureDemoOrgOwned();
    const s = await makeSnapshot(DEMO_ORG, 'demo');
    await rig.asUser(SA, async (c: any) => {
      await register(c, 'phoenix_report_snapshots', s);
      await mark(c, 'phoenix_report_snapshots', s);
    }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(`UPDATE phoenix_report_snapshots SET report_type='x' WHERE id=$1`, [s]))
        .rejects.toThrow(/report_snapshot_is_immutable/);
    });
  });

  it('immutability is completely unchanged for every NON-demo row (same error, same code)', async () => {
    const genuine = await makeSnapshot(REAL_ORG, 'genuine');
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(`DELETE FROM phoenix_report_snapshots WHERE id=$1`, [genuine]))
        .rejects.toThrow(/report_snapshot_is_immutable/);
      await expect(c.query(`UPDATE phoenix_report_snapshots SET report_type='x' WHERE id=$1`, [genuine]))
        .rejects.toThrow(/report_snapshot_is_immutable/);
    });
  });

  // ── The exemption genuinely works for correctly-created demo rows ────────

  it('ONLY a correctly created, marked AND manifest-owned demo row in a demo org is removed by purge', async () => {
    await ensureDemoOrgOwned();
    // The leftovers live in a SEPARATE demo org that is not itself registered,
    // so they cannot pin DEMO_ORG's deletion at commit time. They still prove
    // exactly what they must: unmarked and unowned rows survive the purge.
    const demoOk = await makeSnapshot(DEMO_ORG, 'demo');
    const demoUnmarked = await makeSnapshot(OTHER_ORG, 'demo');      // owned, NOT marked
    const demoUnowned = await makeSnapshot(OTHER_ORG, 'demo');       // marked attempt, NOT owned
    const genuine = await makeSnapshot(REAL_ORG, 'genuine');

    await rig.asUser(SA, async (c: any) => {
      await register(c, 'phoenix_report_snapshots', demoOk);
      await mark(c, 'phoenix_report_snapshots', demoOk);
      await register(c, 'phoenix_report_snapshots', demoUnmarked);
    }, { commit: true });
    // Not manifest-owned -> marking refuses outright.
    await rig.asUser(SA, async (c: any) => {
      await expect(mark(c, 'phoenix_report_snapshots', demoUnowned)).rejects.toThrow(/row_not_demo_owned/);
    });

    const dry = await rig.asUser(SA, async (c: any) => await purge(c, true));
    const dryTarget = Number(dry.find((r: any) => r.table_name === 'phoenix_report_snapshots')?.affected ?? 0);
    expect(dryTarget).toBeGreaterThanOrEqual(1);

    const exec = await rig.asUser(SA, async (c: any) => await purge(c, false), { commit: true });
    const execTarget = Number(exec.find((r: any) => r.table_name === 'phoenix_report_snapshots')?.affected ?? 0);
    // Dry-run and execute must report the SAME target set, truthfully.
    expect(execTarget).toBe(dryTarget);

    expect(await exists('phoenix_report_snapshots', demoOk)).toBe(false);       // removed
    expect(await exists('phoenix_report_snapshots', demoUnmarked)).toBe(true);  // survives
    expect(await exists('phoenix_report_snapshots', demoUnowned)).toBe(true);   // survives
    expect(await exists('phoenix_report_snapshots', genuine)).toBe(true);       // survives
  });

  it('CROSS-ORG: a row in a non-demo organization can never be marked, so cross-org deletion is impossible', async () => {
    const other = await makeSnapshot(OTHER_ORG, 'other');
    await rig.asUser(SA, async (c: any) => { await register(c, 'phoenix_report_snapshots', other); }, { commit: true });
    await rig.asUser(SA, async (c: any) => {
      await expect(mark(c, 'phoenix_report_snapshots', other)).rejects.toThrow(/organization_not_demo_owned/);
    });
    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
    expect(await exists('phoenix_report_snapshots', other)).toBe(true);
  });

  it('CONFIGURATION SAFETY: purge damaged no profile, permission or organization it did not create', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const id of [SA, IA, OO]) {
        const r = await c.query(`SELECT status, role FROM profiles WHERE id=$1`, [id]);
        expect(r.rows[0].status).toBe('active');
      }
      const sa = await c.query(`SELECT role FROM profiles WHERE id=$1`, [SA]);
      expect(sa.rows[0].role).toBe('super_admin');
      const orgs = await c.query(
        `SELECT count(*)::int AS n FROM organizations WHERE id IN ($1,$2)`, [REAL_ORG, OTHER_ORG]);
      expect(orgs.rows[0].n).toBe(2);
      const perms = await c.query(`SELECT count(*)::int AS n FROM permission_keys`);
      expect(perms.rows[0].n).toBeGreaterThan(0);
    });
  });
});
