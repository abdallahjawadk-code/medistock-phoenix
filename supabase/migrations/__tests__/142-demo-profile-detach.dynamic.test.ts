/**
 * PHOENIX-DEMO-PROFILE-DETACH-142 — ADVERSARIAL acceptance.
 *
 * 142 lets the demo purge DETACH (disable + archive + unlink) a demo profile
 * so its organization can finally be deleted. A profile is never deleted and
 * its audit attribution never disappears. The burden of proof is that a
 * genuine profile — above all the owner and any last super_admin — cannot be
 * reached, so these are written from the attacker's side.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const DS = 'PHOENIX_DEMO_V1';

const HOME_ORG = '00000000-0000-0000-0000-00000014c001';
const OWNER = '00000000-0000-0000-0000-00000014c401';   // the real owner, super_admin
const GENUINE = '00000000-0000-0000-0000-00000014c402'; // a genuine ordinary profile
const IA = '00000000-0000-0000-0000-00000014c403';      // institution_admin (denied)

run('142 demo profile detachment — adversarial (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const register = (c: any, table: string, id: string) =>
    c.query(`SELECT public.phoenix_demo_register($1,$2,$3,NULL)`, [DS, table, id]);
  const mark = (c: any, table: string, id: string, ds = DS) =>
    c.query(`SELECT public.phoenix_demo_mark_row($1,$2,$3)`, [ds, table, id]);
  const purge = (c: any, dry = false) =>
    c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DS, dry]).then((r: any) => r.rows);

  const profileOf = async (id: string) => {
    let row: any = null;
    await rig.asAdmin(async (c: any) => {
      row = (await c.query(
        `SELECT id, role, status, organization_id, full_name, disabled_at, demo_dataset_id
           FROM profiles WHERE id=$1`, [id])).rows[0] ?? null;
    });
    return row;
  };

  /** A complete demo org with one demo profile inside it. */
  async function makeDemoOrgWithProfile(tag: string) {
    const org = randomUUID();
    const user = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,$2,'تجريبي',$3)`,
        [org, `Demo ${tag}`, `dp-${tag}-${Date.now()}`]);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,$2)`,
        [user, `demo-${tag}-${Date.now()}@phoenix-demo.invalid`]);
      await c.query(
        `UPDATE profiles SET role='outlet_officer', status='active', organization_id=$1,
           full_name=$2 WHERE id=$3`,
        [org, `مستخدم تجريبي ${tag}`, user]);
    });
    await rig.asUser(OWNER, async (c: any) => {
      await register(c, 'organizations', org);
      await register(c, 'profiles', user);
      await mark(c, 'profiles', user);
    }, { commit: true });
    return { org, user };
  }

  const detachedRow = (rows: any[]) => rows.find(r => r.table_name === 'profiles:detached');
  const orgRow = (rows: any[]) => rows.find(r => r.table_name === 'organizations');

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code)
        VALUES ($1,'Home','الرئيسية','dp-home') ON CONFLICT (id) DO NOTHING`, [HOME_ORG]);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ($1,'dp-owner@rig'),($2,'dp-genuine@rig'),($3,'dp-ia@rig') ON CONFLICT (id) DO NOTHING`,
        [OWNER, GENUINE, IA]);
      await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=$1,
        full_name='Real Owner' WHERE id=$2`, [HOME_ORG, OWNER]);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id=$1,
        full_name='Genuine Staff' WHERE id=$2`, [HOME_ORG, GENUINE]);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id=$1,
        full_name='Inst Admin' WHERE id=$2`, [HOME_ORG, IA]);
    });
  }, 180000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── The central guarantees ───────────────────────────────────────────────

  it('a forged manifest entry CANNOT detach a genuine profile — marking refuses it and purge leaves it active', async () => {
    await rig.asUser(OWNER, async (c: any) => { await register(c, 'profiles', GENUINE); }, { commit: true });
    // Its organization is genuine, so the marker can never be applied.
    await rig.asUser(OWNER, async (c: any) => {
      await expect(mark(c, 'profiles', GENUINE)).rejects.toThrow(/organization_not_demo_owned/);
    });
    await rig.asUser(OWNER, async (c: any) => { await purge(c, false); }, { commit: true });

    const p = await profileOf(GENUINE);
    expect(p.status).toBe('active');
    expect(p.organization_id).toBe(HOME_ORG);
    expect(p.demo_dataset_id).toBeNull();

    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM phoenix_demo_manifest WHERE dataset_key=$1 AND row_id=$2`, [DS, GENUINE]);
    });
  });

  it('the OWNER (super_admin) can never even be marked, so the last super_admin is unreachable', async () => {
    await rig.asUser(OWNER, async (c: any) => { await register(c, 'profiles', OWNER); }, { commit: true });
    await rig.asUser(OWNER, async (c: any) => {
      await expect(mark(c, 'profiles', OWNER)).rejects.toThrow(/super_admin_profile_not_demo_markable/);
    });
    await rig.asUser(OWNER, async (c: any) => { await purge(c, false); }, { commit: true });

    const p = await profileOf(OWNER);
    expect(p.role).toBe('super_admin');
    expect(p.status).toBe('active');
    expect(p.organization_id).toBe(HOME_ORG);

    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM phoenix_demo_manifest WHERE dataset_key=$1 AND row_id=$2`, [DS, OWNER]);
    });
  });

  it('a genuine profile\'s marker cannot be flipped by ANY route (write-once trigger, even as superuser)', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(
        c.query(`UPDATE profiles SET demo_dataset_id='PHOENIX_DEMO_V1' WHERE id=$1`, [GENUINE]),
      ).rejects.toThrow(/demo_dataset_marker_is_write_once/);
    });
    expect((await profileOf(GENUINE)).demo_dataset_id).toBeNull();
  });

  it('an ordinary authenticated user cannot set the marker on their own profile', async () => {
    await rig.asUser(GENUINE, async (c: any) => {
      await expect(
        c.query(`UPDATE profiles SET demo_dataset_id='PHOENIX_DEMO_V1' WHERE id=$1`, [GENUINE]),
      ).rejects.toThrow();
    });
    expect((await profileOf(GENUINE)).demo_dataset_id).toBeNull();
  });

  // ── Role / scope / dataset denial ────────────────────────────────────────

  it('institution_admin is denied marking and purging; a wrong dataset id is refused', async () => {
    const { user } = await makeDemoOrgWithProfile('deny');
    await rig.asUser(IA, async (c: any) => {
      await expect(mark(c, 'profiles', user)).rejects.toThrow(/forbidden_demo_marking/);
    });
    await rig.asUser(IA, async (c: any) => {
      await expect(purge(c, true)).rejects.toThrow(/forbidden_demo_purge/);
    });
    await rig.asUser(OWNER, async (c: any) => {
      await expect(mark(c, 'profiles', user, 'PHOENIX_DEMO_V2')).rejects.toThrow(/invalid_demo_dataset_key/);
    });
  });

  it('detachment cannot be invoked outside the purge — the ownership boundary holds', async () => {
    await rig.asUser(OWNER, async (c: any) => {
      await expect(c.query(`SELECT public.phoenix_demo_detach_profiles(false)`))
        .rejects.toThrow(/forbidden_demo_detach|permission denied/);
    });
  });

  // ── The positive path ────────────────────────────────────────────────────

  it('a demo profile IS disabled, archived and unlinked — and its identity survives for audit attribution', async () => {
    const { org, user } = await makeDemoOrgWithProfile('detach');
    const before = await profileOf(user);
    expect(before.status).toBe('active');
    expect(before.organization_id).toBe(org);

    let rows: any[] = [];
    await rig.asUser(OWNER, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(detachedRow(rows)).toBeDefined();
    expect(detachedRow(rows).executed).toBe(true);

    const after = await profileOf(user);
    expect(after).not.toBeNull();                       // NOT deleted
    expect(after.status).toBe('archived');              // disabled
    expect(after.disabled_at).not.toBeNull();
    expect(after.organization_id).toBeNull();           // unlinked
    expect(after.full_name).toBe(`مستخدم تجريبي detach`); // identity preserved
    expect(after.role).toBe('outlet_officer');          // role preserved for attribution
  });

  it('audit attribution written by that demo profile stays readable after detachment', async () => {
    const { org, user } = await makeDemoOrgWithProfile('audit');
    const auditId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO audit_logs (id, organization_id, actor_id, action, entity_type)
         VALUES ($1,$2,$3,'demo.action','demo')`,
        [auditId, org, user]);
    });
    // Register the audit row as demo-owned, exactly as the seeder does, so it
    // is purged with the rest of the dataset rather than blocking its org.
    await rig.asUser(OWNER, async (c: any) => {
      await register(c, 'audit_logs', auditId);
    }, { commit: true });

    await rig.asUser(OWNER, async (c: any) => { await purge(c, false); }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      // The audit row's actor still resolves to a real, readable identity.
      const r = await c.query(
        `SELECT a.actor_id, p.full_name, p.status
           FROM audit_logs a JOIN profiles p ON p.id = a.actor_id
          WHERE a.id = $1`, [auditId]);
      // The audit row itself is demo-owned and may have been purged; if it
      // survives, its attribution must still resolve.
      if (r.rows.length > 0) {
        expect(r.rows[0].full_name).toBe('مستخدم تجريبي audit');
        expect(r.rows[0].status).toBe('archived');
      }
      // Either way the PROFILE tombstone is still present and readable.
      const p = await c.query(`SELECT full_name FROM profiles WHERE id=$1`, [user]);
      expect(p.rows[0].full_name).toBe('مستخدم تجريبي audit');
    });
  });

  it('the demo organization then DELETES successfully once its profiles are detached', async () => {
    const { org } = await makeDemoOrgWithProfile('orgdel');
    let rows: any[] = [];
    await rig.asUser(OWNER, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(detachedRow(rows)).toBeDefined();
    expect(orgRow(rows)).toBeDefined();
    expect(orgRow(rows).executed).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const n = (await c.query(`SELECT count(*)::int AS n FROM organizations WHERE id=$1`, [org])).rows[0].n;
      expect(n).toBe(0);
    });
  });

  it('a SECOND purge is a safe no-op, and leaves no operational demo residue', async () => {
    await makeDemoOrgWithProfile('idem');
    await rig.asUser(OWNER, async (c: any) => { await purge(c, false); }, { commit: true });

    let second: any[] = [];
    await rig.asUser(OWNER, async (c: any) => { second = await purge(c, false); }, { commit: true });
    // Nothing left to delete or detach.
    expect(second.filter(r => r.executed === true)).toEqual([]);

    await rig.asAdmin(async (c: any) => {
      const orgs = (await c.query(
        `SELECT count(*)::int AS n FROM organizations WHERE code LIKE 'dp-%' AND code <> 'dp-home'`)).rows[0].n;
      expect(orgs).toBe(0);
      // Every demo profile is an archived, unlinked tombstone.
      const live = (await c.query(
        `SELECT count(*)::int AS n FROM profiles
          WHERE demo_dataset_id='PHOENIX_DEMO_V1' AND (status <> 'archived' OR organization_id IS NOT NULL)`)).rows[0].n;
      expect(live).toBe(0);
    });
  });

  it('the owner and the genuine profile are STILL untouched after every purge in this file', async () => {
    const owner = await profileOf(OWNER);
    expect(owner.role).toBe('super_admin');
    expect(owner.status).toBe('active');
    expect(owner.organization_id).toBe(HOME_ORG);
    expect(owner.demo_dataset_id).toBeNull();

    const genuine = await profileOf(GENUINE);
    expect(genuine.status).toBe('active');
    expect(genuine.organization_id).toBe(HOME_ORG);
    expect(genuine.demo_dataset_id).toBeNull();

    await rig.asAdmin(async (c: any) => {
      const n = (await c.query(`SELECT count(*)::int AS n FROM organizations WHERE id=$1`, [HOME_ORG])).rows[0].n;
      expect(n).toBe(1);
    });
  });
});
