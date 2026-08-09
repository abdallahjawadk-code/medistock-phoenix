import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rigAvailable, buildRig } from '../tools/pg-rig/rig.mjs';

/**
 * SECURITY-ARCH-HARDENING-A — D1 atomic lifecycle guard, exercised on the
 * disposable Postgres rig (real migrations 001→latest, real RLS, real
 * auth.uid()). Skips when PHOENIX_RIG_PG is unset (e.g. CI), like every other
 * rig-backed test in this repo.
 *
 * Proves:
 *  1. Two CONCURRENT disable reservations that would each drop the last two
 *     super_admins, over two independent connections, can never reach zero
 *     active super_admins — exactly one succeeds, the other is refused.
 *  2. The same for concurrent delete.
 *  3. Compensation restores the EXACT prior status after a simulated external
 *     (Auth) failure — no half-deleted account, no privilege change.
 *  4. D2: authorization/existence denials are indistinguishable to the caller
 *     (all 'REQUEST_DENIED') while the real reason is recorded server-side.
 *  5. The lifecycle functions are not executable by anon.
 */

const SA_ROOT = '00000000-0000-0000-0000-0000000000a1'; // seeded by the rig
const SA_TWO  = '00000000-0000-0000-0000-0000000000a2';
const INST_ADMIN = '00000000-0000-0000-0000-0000000000b1';
const TARGET_OTHER_ORG = '00000000-0000-0000-0000-0000000000c1';
const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';

const maybe = rigAvailable() ? describe : describe.skip;

maybe('D1/D2 atomic account-lifecycle guard (rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 999 });
    await rig.asAdmin(async (c) => {
      await c.query(
        `insert into organizations (id, name, name_ar, code, institution_class) values
           ($1,'Org A','منظمة أ','rig-org-a','hospital'),($2,'Org B','منظمة ب','rig-org-b','hospital')
         on conflict (id) do nothing`, [ORG_A, ORG_B]);
      for (const [id, role, org, name] of [
        [SA_TWO, 'super_admin', null, 'SA Two'],
        [INST_ADMIN, 'institution_admin', ORG_A, 'Inst Admin'],
        [TARGET_OTHER_ORG, 'outlet_officer', ORG_B, 'Other Org Target'],
      ] as const) {
        await c.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, jsonb_build_object('full_name',$3::text,'role',$4::text))
           on conflict (id) do nothing`, [id, `${name.replace(/\s/g, '')}@rig.local`, name, role]);
        await c.query(
          `insert into public.profiles (id, organization_id, full_name, role, status)
           values ($1,$2,$3,$4,'active')
           on conflict (id) do update set organization_id=excluded.organization_id,
             role=excluded.role, status='active'`, [id, org, name, role]);
      }
      // Give the institution_admin users.disable so it clears the actor gate and
      // reaches the target checks (proving those are the ones that unify).
      await c.query(
        `insert into public.profile_permission_overrides (profile_id, permission_key, allowed, created_by)
         values ($1, 'users.disable', true, $1)
         on conflict (profile_id, permission_key) do update set allowed = true`, [INST_ADMIN]);
    });
  }, 300_000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function reset(...activeSuper: string[]) {
    await rig.asAdmin(async (c) => {
      await c.query(`delete from public.profile_lifecycle_reservations`);
      await c.query(`update public.profiles set status='active', disabled_at=null, disabled_by=null
                     where id = any($1)`, [activeSuper]);
    });
  }
  async function countActiveSuper(): Promise<number> {
    return rig.asAdmin(async (c) =>
      (await c.query(`select count(*)::int n from public.profiles
                      where role='super_admin' and status='active'`)).rows[0].n as number);
  }
  async function openActor(sub: string) {
    const client = await rig.pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    return client;
  }

  // The core race: two DIFFERENT super_admins each try to remove the other at
  // the same time. Without the lock+persist both read count=2 and win → zero.
  async function mutualRace(action: 'disable' | 'delete') {
    await reset(SA_ROOT, SA_TWO);
    expect(await countActiveSuper()).toBe(2);

    const a = await openActor(SA_ROOT); // SA_ROOT acts on SA_TWO
    const b = await openActor(SA_TWO);  // SA_TWO acts on SA_ROOT
    try {
      const ra = await a.query(`select public.phoenix_lifecycle_reserve($1,$2) r`, [SA_TWO, action]);
      const bPromise = b.query(`select public.phoenix_lifecycle_reserve($1,$2) r`, [SA_ROOT, action]);
      await new Promise((res) => setTimeout(res, 150)); // let B reach the lock wait
      await a.query('COMMIT');
      const rb = await bPromise;
      await b.query('COMMIT');

      expect(ra.rows[0].r.ok).toBe(true);
      expect(rb.rows[0].r.ok).toBe(false);        // the second is always refused
      expect(rb.rows[0].r.correlation_id).toBeTruthy();
      expect(await countActiveSuper()).toBeGreaterThanOrEqual(1); // never zero
    } finally {
      try { await a.query('ROLLBACK'); } catch { /* committed */ }
      try { await b.query('ROLLBACK'); } catch { /* committed */ }
      a.release(); b.release();
    }
  }

  it('concurrent disable of the last two super_admins cannot reach zero', async () => {
    await mutualRace('disable');
  }, 60_000);

  it('concurrent delete of the last two super_admins cannot reach zero', async () => {
    await mutualRace('delete');
  }, 60_000);

  it('compensation restores the exact prior status (no half-deleted account)', async () => {
    await reset(SA_ROOT, SA_TWO);
    // SA_ROOT reserves a DELETE of SA_TWO (2 active → allowed).
    await rig.asUser(SA_ROOT, async (c) => {
      const r = await c.query(`select public.phoenix_lifecycle_reserve($1,'delete') r`, [SA_TWO]);
      expect(r.rows[0].r.ok).toBe(true);
    }, { commit: true });
    // Mid-flight the target is suspended (reserved) with a reservation row.
    const mid = await rig.asAdmin((c) => c.query(
      `select status from public.profiles where id=$1`, [SA_TWO]));
    expect(mid.rows[0].status).toBe('suspended');
    // Simulate the external Auth delete FAILING → compensate.
    await rig.asUser(SA_ROOT, async (c) => {
      const r = await c.query(`select public.phoenix_lifecycle_compensate($1) r`, [SA_TWO]);
      expect(r.rows[0].r.ok).toBe(true);
      expect(r.rows[0].r.restored_status).toBe('active');
    }, { commit: true });
    const after = await rig.asAdmin((c) => c.query(
      `select status, disabled_at from public.profiles where id=$1`, [SA_TWO]));
    expect(after.rows[0].status).toBe('active');
    expect(after.rows[0].disabled_at).toBeNull();
    const res = await rig.asAdmin((c) => c.query(
      `select count(*)::int n from public.profile_lifecycle_reservations where profile_id=$1`, [SA_TWO]));
    expect(res.rows[0].n).toBe(0);
  }, 60_000);

  it('D2: authz/existence denials are one generic code; real reason logged server-side', async () => {
    await reset(SA_ROOT, SA_TWO);
    const nonexistent = '00000000-0000-0000-0000-0000000000ff';
    const r = await rig.asUser(INST_ADMIN, async (c) => ({
      notFound: (await c.query(`select public.phoenix_lifecycle_reserve($1,'disable') r`, [nonexistent])).rows[0].r,
      crossOrg: (await c.query(`select public.phoenix_lifecycle_reserve($1,'disable') r`, [TARGET_OTHER_ORG])).rows[0].r,
      platform: (await c.query(`select public.phoenix_lifecycle_reserve($1,'disable') r`, [SA_ROOT])).rows[0].r,
    }), { commit: true });

    for (const one of Object.values(r)) {
      expect(one.ok).toBe(false);
      expect(one.error).toBe('REQUEST_DENIED');   // no existence oracle
      expect(one.correlation_id).toBeTruthy();
    }
    const reasons = await rig.asAdmin((c) => c.query(
      `select payload->>'reason' reason from public.audit_logs
       where action='security.access_denied' and actor_id=$1`, [INST_ADMIN]));
    const set = new Set(reasons.rows.map((x: { reason: string }) => x.reason));
    expect(set.has('target_not_found')).toBe(true);
    expect(set.has('cross_org')).toBe(true);
    expect(set.has('target_platform_managed')).toBe(true);
  }, 60_000);

  it('lifecycle reserve is not executable by anon', async () => {
    await expect(
      rig.asUser(SA_ROOT, (c) =>
        c.query(`select public.phoenix_lifecycle_reserve($1,'disable') r`, [SA_TWO]),
        { role: 'anon' }),
    ).rejects.toThrow(/permission denied/i);
  }, 60_000);
});
