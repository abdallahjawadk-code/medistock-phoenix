import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ROOT = '00000000-0000-0000-0000-0000000000a1';
const ORG_A = '14600000-0000-4000-8000-00000000000a';
const ORG_B = '14600000-0000-4000-8000-00000000000b';
const INST = '14600000-0000-4000-8000-0000000000a1';

const NEW_SUPER_LOCAL = '14600000-0000-4000-8000-000000000101';
const NEW_INST_LOCAL = '14600000-0000-4000-8000-000000000102';
const NEW_CROSS_ORG = '14600000-0000-4000-8000-000000000103';
const NEW_PRIVILEGED = '14600000-0000-4000-8000-000000000104';
const NEW_SUSPENDED = '14600000-0000-4000-8000-000000000105';
const NEW_BAD_NONCE = '14600000-0000-4000-8000-000000000106';
const GENUINE_EXISTING = '14600000-0000-4000-8000-000000000107';
const NO_AUTH_TARGET = '14600000-0000-4000-8000-000000000108';

type Rig = Awaited<ReturnType<typeof buildRig>>;

run('migration 146 — service-only one-shot user provisioning', () => {
  let rig: Rig;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 146 });
    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into public.organizations (id, name, name_ar, code, status)
         values
           ($1, 'Provisioning Org A', 'مؤسسة الاختبار أ', 'prov-146-a', 'active'),
           ($2, 'Provisioning Org B', 'مؤسسة الاختبار ب', 'prov-146-b', 'active')
         on conflict (id) do nothing`,
        [ORG_A, ORG_B],
      );

      await c.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values (
           $1,
           'institution-admin-146@rig.local',
           jsonb_build_object('full_name', 'Institution Admin 146', 'role', 'institution_admin')
         )
         on conflict (id) do nothing`,
        [INST],
      );
      await c.query(
        `update public.profiles
         set organization_id = $2, role = 'institution_admin', status = 'active'
         where id = $1`,
        [INST, ORG_A],
      );
      for (const permission of ['users.create', 'users.assign_role']) {
        await c.query(
          `insert into public.profile_permission_overrides
             (profile_id, permission_key, allowed, created_by)
           values ($1, $2, true, $1)
           on conflict (profile_id, permission_key)
           do update set allowed = true`,
          [INST, permission],
        );
      }
    });
  }, 300_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  async function createPlaceholder(
    id: string,
    actorId: string,
    nonce: string,
    fullName: string,
    username: string,
  ) {
    await rig.asAdmin((c) =>
      c.query(
        `insert into auth.users (
           id, email, raw_user_meta_data, raw_app_meta_data
         )
         values (
           $1,
           $2,
           jsonb_build_object('full_name', $3::text),
           jsonb_build_object(
             'phoenix_provisioning_nonce', $4::text,
             'phoenix_provisioning_actor_id', $5::text
           )
         )`,
        [id, `${username}@local.medistock.invalid`, fullName, nonce, actorId],
      ),
    );
  }

  async function callService(args: {
    actorId: string;
    newId: string;
    nonce: string;
    orgId: string;
    fullName: string;
    role: string;
    username: string;
  }) {
    return rig.asAdmin(async (c) => {
      await c.query('begin');
      try {
        await c.query('set local role service_role');
        const result = await c.query(
          `select public.phoenix_admin_provision_profile(
             $1,$2,$3,$4,$5,$6,'local',$7,null,$8
           ) result`,
          [
            args.actorId,
            args.newId,
            args.nonce,
            args.orgId,
            args.fullName,
            args.role,
            args.username,
            crypto.randomUUID(),
          ],
        );
        await c.query('commit');
        return result.rows[0].result;
      } catch (error) {
        await c.query('rollback');
        throw error;
      }
    });
  }

  it('revokes direct authenticated execution of both old and new RPCs', async () => {
    await expect(
      rig.asUser(ROOT, (c) =>
        c.query(
          `select public.phoenix_admin_provision_profile(
             $1,$2,$3,$4,'Blocked','outlet_officer','local','blocked',null,$5
           )`,
          [ROOT, NO_AUTH_TARGET, crypto.randomUUID(), ORG_A, crypto.randomUUID()],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      rig.asUser(ROOT, (c) =>
        c.query(
          `select public.phoenix_provision_profile(
             $1,$2,'Blocked','outlet_officer','local','blocked',null,$3
           )`,
          [NO_AUTH_TARGET, ORG_A, crypto.randomUUID()],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('allows an active super_admin to convert exactly one fresh placeholder', async () => {
    const nonce = crypto.randomUUID();
    await createPlaceholder(
      NEW_SUPER_LOCAL,
      ROOT,
      nonce,
      'Fresh Warehouse Officer',
      'fresh.warehouse',
    );

    const result = await callService({
      actorId: ROOT,
      newId: NEW_SUPER_LOCAL,
      nonce,
      orgId: ORG_A,
      fullName: 'Fresh Warehouse Officer',
      role: 'warehouse_officer',
      username: 'fresh.warehouse',
    });
    expect(result.ok).toBe(true);

    const row = await rig.asAdmin((c) =>
      c.query(
        `select organization_id, full_name, role, status, login_mode,
                username, must_change_password
         from public.profiles where id = $1`,
        [NEW_SUPER_LOCAL],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      organization_id: ORG_A,
      full_name: 'Fresh Warehouse Officer',
      role: 'warehouse_officer',
      status: 'active',
      login_mode: 'local',
      username: 'fresh.warehouse',
      must_change_password: true,
    });
  });

  it('is one-shot: a replay cannot modify the now-real profile', async () => {
    const before = await rig.asAdmin((c) =>
      c.query(
        `select organization_id, full_name, role, status, login_mode, username
         from public.profiles where id = $1`,
        [NEW_SUPER_LOCAL],
      ),
    );
    const nonce = await rig.asAdmin(async (c) => {
      const q = await c.query(
        `select raw_app_meta_data->>'phoenix_provisioning_nonce' nonce
         from auth.users where id = $1`,
        [NEW_SUPER_LOCAL],
      );
      return q.rows[0].nonce as string;
    });

    const replay = await callService({
      actorId: ROOT,
      newId: NEW_SUPER_LOCAL,
      nonce,
      orgId: ORG_B,
      fullName: 'Attempted Overwrite',
      role: 'super_admin',
      username: 'attempted.overwrite',
    });
    expect(replay).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });

    const after = await rig.asAdmin((c) =>
      c.query(
        `select organization_id, full_name, role, status, login_mode, username
         from public.profiles where id = $1`,
        [NEW_SUPER_LOCAL],
      ),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('allows an institution_admin with both permissions in their own org', async () => {
    const nonce = crypto.randomUUID();
    await createPlaceholder(
      NEW_INST_LOCAL,
      INST,
      nonce,
      'Institution Outlet Officer',
      'inst.outlet',
    );
    const result = await callService({
      actorId: INST,
      newId: NEW_INST_LOCAL,
      nonce,
      orgId: ORG_A,
      fullName: 'Institution Outlet Officer',
      role: 'outlet_officer',
      username: 'inst.outlet',
    });
    expect(result).toMatchObject({ ok: true, role: 'outlet_officer' });
  });

  it('denies an institution_admin crossing organization scope', async () => {
    const nonce = crypto.randomUUID();
    await createPlaceholder(
      NEW_CROSS_ORG,
      INST,
      nonce,
      'Cross Org Attempt',
      'cross.org',
    );
    const result = await callService({
      actorId: INST,
      newId: NEW_CROSS_ORG,
      nonce,
      orgId: ORG_B,
      fullName: 'Cross Org Attempt',
      role: 'outlet_officer',
      username: 'cross.org',
    });
    expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
  });

  it('denies privileged-role creation by a non-super administrator', async () => {
    const nonce = crypto.randomUUID();
    await createPlaceholder(
      NEW_PRIVILEGED,
      INST,
      nonce,
      'Privilege Escalation Attempt',
      'priv.attempt',
    );
    const result = await callService({
      actorId: INST,
      newId: NEW_PRIVILEGED,
      nonce,
      orgId: ORG_A,
      fullName: 'Privilege Escalation Attempt',
      role: 'institution_admin',
      username: 'priv.attempt',
    });
    expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
  });

  it('denies a suspended actor even when permissions remain granted', async () => {
    const nonce = crypto.randomUUID();
    await createPlaceholder(
      NEW_SUSPENDED,
      INST,
      nonce,
      'Suspended Actor Attempt',
      'suspended.attempt',
    );
    await rig.asAdmin((c) =>
      c.query(`update public.profiles set status = 'suspended' where id = $1`, [INST]),
    );
    try {
      const result = await callService({
        actorId: INST,
        newId: NEW_SUSPENDED,
        nonce,
        orgId: ORG_A,
        fullName: 'Suspended Actor Attempt',
        role: 'outlet_officer',
        username: 'suspended.attempt',
      });
      expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
    } finally {
      await rig.asAdmin((c) =>
        c.query(`update public.profiles set status = 'active' where id = $1`, [INST]),
      );
    }
  });

  it('denies a missing/wrong provisioning nonce and preserves the placeholder', async () => {
    const realNonce = crypto.randomUUID();
    await createPlaceholder(
      NEW_BAD_NONCE,
      ROOT,
      realNonce,
      'Nonce Mismatch',
      'nonce.mismatch',
    );
    const result = await callService({
      actorId: ROOT,
      newId: NEW_BAD_NONCE,
      nonce: crypto.randomUUID(),
      orgId: ORG_A,
      fullName: 'Nonce Mismatch',
      role: 'warehouse_officer',
      username: 'nonce.mismatch',
    });
    expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });

    const row = await rig.asAdmin((c) =>
      c.query(`select organization_id, role, login_mode from public.profiles where id = $1`, [
        NEW_BAD_NONCE,
      ]),
    );
    expect(row.rows[0]).toEqual({
      organization_id: null,
      role: 'outlet_officer',
      login_mode: 'email',
    });
  });

  it('cannot overwrite a genuine profile even with forged matching app metadata', async () => {
    const nonce = crypto.randomUUID();
    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into auth.users (
           id, email, raw_user_meta_data, raw_app_meta_data
         )
         values (
           $1,
           'genuine-146@rig.local',
           jsonb_build_object('full_name', 'Genuine Existing'),
           jsonb_build_object(
             'phoenix_provisioning_nonce', $2::text,
             'phoenix_provisioning_actor_id', $3::text
           )
         )`,
        [GENUINE_EXISTING, nonce, ROOT],
      );
      await c.query(
        `update public.profiles
         set organization_id = $2,
             full_name = 'Genuine Existing',
             role = 'warehouse_officer',
             login_mode = 'local',
             username = 'genuine.existing',
             must_change_password = true
         where id = $1`,
        [GENUINE_EXISTING, ORG_A],
      );
    });

    const before = await rig.asAdmin((c) =>
      c.query(`select * from public.profiles where id = $1`, [GENUINE_EXISTING]),
    );
    const result = await callService({
      actorId: ROOT,
      newId: GENUINE_EXISTING,
      nonce,
      orgId: ORG_B,
      fullName: 'Overwritten',
      role: 'super_admin',
      username: 'overwritten',
    });
    expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
    const after = await rig.asAdmin((c) =>
      c.query(`select * from public.profiles where id = $1`, [GENUINE_EXISTING]),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('fails closed when the target Auth user/placeholder does not exist', async () => {
    const result = await callService({
      actorId: ROOT,
      newId: NO_AUTH_TARGET,
      nonce: crypto.randomUUID(),
      orgId: ORG_A,
      fullName: 'Missing Target',
      role: 'outlet_officer',
      username: 'missing.target',
    });
    expect(result).toMatchObject({ ok: false, error: 'REQUEST_DENIED' });
    const count = await rig.asAdmin((c) =>
      c.query(`select count(*)::int n from public.profiles where id = $1`, [NO_AUTH_TARGET]),
    );
    expect(count.rows[0].n).toBe(0);
  });
});
