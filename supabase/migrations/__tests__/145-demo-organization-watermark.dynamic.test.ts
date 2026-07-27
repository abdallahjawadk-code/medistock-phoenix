/**
 * PHOENIX-DEMO-ORGANIZATION-WATERMARK-145 — DYNAMIC operational acceptance
 * against a real disposable Postgres with 001->145 applied in order.
 *
 * phoenix_is_demo_organization() is the frontend's ONLY way to ask "should
 * this organization's reports be watermarked as demo data" — narrow proofs:
 *   * a genuinely demo-manifest-registered organization reads true;
 *   * a real, unregistered organization reads false, even in the presence
 *     of demo-manifest rows for OTHER organizations (no cross-contamination);
 *   * an unauthenticated caller is refused, not merely returned false;
 *   * a random/never-existing id reads false, not an error;
 *   * NULL reads false, not an error or NULL.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const DATASET = 'PHOENIX_DEMO_V1';
const DEMO_ORG = '00000000-0000-0000-0000-000000145001';
const REAL_ORG = '00000000-0000-0000-0000-000000145002';
const SA = '00000000-0000-0000-0000-000000145401';

run('145 demo organization watermark — phoenix_is_demo_organization (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${DEMO_ORG}','Demo Org','منظمة تجريبية','demo-org-145'),
        ('${REAL_ORG}','Real Org','منظمة حقيقية','real-org-145')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${SA}','sa-145@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='super_admin',status='active',
        organization_id='${REAL_ORG}', full_name='SA 145' WHERE id='${SA}';`);
      await c.query(`INSERT INTO public.phoenix_demo_manifest (dataset_key, table_name, row_id)
        VALUES ($1,'organizations',$2) ON CONFLICT DO NOTHING`, [DATASET, DEMO_ORG]);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('a demo-manifest-registered organization reads true', async () => {
    let out: boolean | null = null;
    await rig.asUser(SA, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_is_demo_organization($1) AS is_demo`, [DEMO_ORG]);
      out = r.rows[0].is_demo;
    });
    expect(out).toBe(true);
  });

  it('a real, unregistered organization reads false, even alongside a registered demo org', async () => {
    let out: boolean | null = null;
    await rig.asUser(SA, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_is_demo_organization($1) AS is_demo`, [REAL_ORG]);
      out = r.rows[0].is_demo;
    });
    expect(out).toBe(false);
  });

  it('a random, never-existing organization id reads false, not an error', async () => {
    let out: boolean | null = null;
    await rig.asUser(SA, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_is_demo_organization(gen_random_uuid()) AS is_demo`);
      out = r.rows[0].is_demo;
    });
    expect(out).toBe(false);
  });

  it('NULL reads false, not an error or NULL', async () => {
    let out: unknown = 'unset';
    await rig.asUser(SA, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_is_demo_organization(NULL) AS is_demo`);
      out = r.rows[0].is_demo;
    });
    expect(out).toBe(false);
  });

  it('an unauthenticated caller is refused', async () => {
    await expect(
      rig.asUser(null, async (c: any) => {
        await c.query(`SELECT public.phoenix_is_demo_organization($1)`, [DEMO_ORG]);
      }),
    ).rejects.toThrow(/not_authenticated/);
  });
});
