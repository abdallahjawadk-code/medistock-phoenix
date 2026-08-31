/**
 * 201 · ORGANIZATION ARCHIVE DEPENDENCY GUARD (ISW1-D1) — dynamic proof.
 *
 * IS-W1 proved that an organization could be archived while every dependency it
 * was supposed to be protected by was still live: with the four impact counts
 * faulted, the wizard offered the action and the server answered
 * `PATCH /rest/v1/organizations -> 204`. Nothing in the database objected,
 * because nothing in the database had ever been asked to.
 *
 * The frontend half of the repair is necessary but not sufficient — it only
 * governs one client. This file proves the half that governs ALL of them:
 *
 *   * each canonical blocking class refuses the archive ON ITS OWN;
 *   * all four together refuse it;
 *   * a genuinely empty organization still archives;
 *   * the refusal is a direct-UPDATE refusal, so no client can route around it;
 *   * RLS is untouched — an unauthorized actor is still refused, and an
 *     authorized actor is refused too when dependencies exist;
 *   * a refusal MOVES NOTHING, proved by measuring rows, never by reading an
 *     exception string;
 *   * the pre-existing activation guard still behaves exactly as before;
 *   * a concurrent dependency insert cannot slip between the count and the
 *     archive.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000, hookTimeout: 300000 });

const run = rigAvailable() ? describe : describe.skip;

const BLOCKED = 'organization_archive_blocked_by_dependencies';

/** Capture a rejection's message + detail, or fail if the call succeeded. */
const rejects = async (fn: () => Promise<unknown>): Promise<{ message: string; code: string; detail: string }> => {
  try {
    await fn();
  } catch (e: any) {
    return { message: e?.message ?? String(e), code: e?.code ?? '', detail: e?.detail ?? '' };
  }
  throw new Error('expected a rejection but the call succeeded');
};

run('201 · organization archive dependency guard', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const ORG = randomUUID();
  const EMPTY_ORG = randomUUID();
  const CENTRAL_ITEM = randomUUID();
  const WH = randomUUID();
  const DP = randomUUID();
  const LI = randomUUID();
  const IA = randomUUID();
  const QT = randomUUID();
  const QK = randomUUID();

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  /** Rebuild ORG with exactly the dependency classes named. */
  async function reset(classes: string[]): Promise<void> {
    await asAdmin(`DELETE FROM qr_tokens WHERE organization_id = $1`, [ORG]);
    await asAdmin(`DELETE FROM qr_targets WHERE organization_id = $1`, [ORG]);
    await asAdmin(`DELETE FROM item_availability WHERE organization_id = $1`, [ORG]);
    await asAdmin(`DELETE FROM local_items WHERE organization_id = $1`, [ORG]);
    await asAdmin(`DELETE FROM distribution_points WHERE organization_id = $1`, [ORG]);
    await asAdmin(`DELETE FROM warehouses WHERE organization_id = $1`, [ORG]);
    await asAdmin(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ORG]);

    // item_availability needs an outlet, and an outlet needs a warehouse, so the
    // narrower cases archive the scaffolding they had to build.
    const needsWh = classes.some((c) => ['warehouses', 'distribution_points', 'qr_tokens', 'item_availability'].includes(c));
    if (needsWh) {
      await asAdmin(
        // NOT main: warehouses_main_requires_active_chk (060) forbids archiving a
        // main warehouse, and the narrower cases below must be able to archive
        // this scaffolding so the class under test is the only thing blocking.
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W201','مخزن','institution',false,'active')`, [WH, ORG]);
    }
    if (classes.some((c) => ['distribution_points', 'qr_tokens', 'item_availability'].includes(c))) {
      await asAdmin(
        `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'P201','منفذ','pharmacy','active')`, [DP, WH, ORG]);
    }
    if (classes.includes('item_availability')) {
      await asAdmin(
        `INSERT INTO local_items (id,central_item_id,organization_id,local_name,status)
         VALUES ($1,$2,$3,'L201','active')`, [LI, CENTRAL_ITEM, ORG]);
      await asAdmin(
        `INSERT INTO item_availability (id,local_item_id,distribution_point_id,organization_id,quantity,condition,source_kind)
         VALUES ($1,$2,$3,$4,5,'available','manual')`, [IA, LI, DP, ORG]);
    }
    if (classes.includes('qr_tokens')) {
      await asAdmin(
        `INSERT INTO qr_targets (id,organization_id,target_type,target_id,label,status)
         VALUES ($1,$2,'distribution_point',$3,'Q201','active')`, [QT, ORG, DP]);
      await asAdmin(
        `INSERT INTO qr_tokens (id,qr_target_id,organization_id,public_id,token_hash,status)
         VALUES ($1,$2,$3,'p201' || substr(md5(random()::text),1,12), encode(digest('t201','sha256'),'hex'),'active')`,
        [QK, QT, ORG]);
    }

    // Archive away any scaffolding the case did not actually ask for, so the
    // class under test is genuinely the only thing blocking.
    if (!classes.includes('warehouses') && needsWh) {
      await asAdmin(`UPDATE warehouses SET status='archived' WHERE id=$1`, [WH]);
    }
    if (!classes.includes('distribution_points')) {
      await asAdmin(`UPDATE distribution_points SET status='archived' WHERE organization_id=$1`, [ORG]);
    }
  }

  const archiveAsAdmin = () =>
    asAdmin(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG]);

  const statusOf = async (id: string): Promise<string> =>
    (await asAdmin(`SELECT status FROM organizations WHERE id=$1`, [id])).rows[0].status;

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(
      `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
         ($1,'Org201','منظمة','org-201','care_institution','hospital','active'),
         ($2,'Empty201','فارغة','org-201e','care_institution','hospital','active')`,
      [ORG, EMPTY_ORG]);
    await asAdmin(
      `INSERT INTO central_items (id,name,name_ar,unit,status) VALUES ($1,'C201','صنف','box','active')`,
      [CENTRAL_ITEM]);
  });

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ── each canonical class blocks on its own ────────────────────────────────
  for (const cls of ['warehouses', 'distribution_points', 'qr_tokens', 'item_availability']) {
    it(`refuses the archive when only ${cls} is live`, async () => {
      await reset([cls]);
      const err = await rejects(archiveAsAdmin);
      expect(err.message).toContain(BLOCKED);
      expect(err.code).toBe('23514');
      expect(await statusOf(ORG)).toBe('active');
    });
  }

  it('refuses the archive when all four classes are live, and names each count', async () => {
    await reset(['warehouses', 'distribution_points', 'qr_tokens', 'item_availability']);
    const err = await rejects(archiveAsAdmin);
    expect(err.message).toContain(BLOCKED);
    expect(err.code).toBe('23514');
    expect(err.detail).toMatch(/warehouses=\d+ distribution_points=\d+ qr_tokens=\d+ item_availability=\d+/);
    expect(await statusOf(ORG)).toBe('active');
  });

  it('a refusal moves nothing', async () => {
    await reset(['warehouses', 'distribution_points', 'qr_tokens', 'item_availability']);
    const before = await asAdmin(
      `SELECT (SELECT count(*) FROM warehouses WHERE organization_id=$1) w,
              (SELECT count(*) FROM distribution_points WHERE organization_id=$1) d,
              (SELECT count(*) FROM qr_tokens WHERE organization_id=$1) q,
              (SELECT count(*) FROM item_availability WHERE organization_id=$1) i,
              (SELECT count(*) FROM audit_logs) a`, [ORG]);
    await rejects(archiveAsAdmin);
    const after = await asAdmin(
      `SELECT (SELECT count(*) FROM warehouses WHERE organization_id=$1) w,
              (SELECT count(*) FROM distribution_points WHERE organization_id=$1) d,
              (SELECT count(*) FROM qr_tokens WHERE organization_id=$1) q,
              (SELECT count(*) FROM item_availability WHERE organization_id=$1) i,
              (SELECT count(*) FROM audit_logs) a`, [ORG]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await statusOf(ORG)).toBe('active');
  });

  // ── the legitimate path still works ───────────────────────────────────────
  it('allows the archive when the organization is genuinely empty', async () => {
    await reset([]);
    await archiveAsAdmin();
    expect(await statusOf(ORG)).toBe('inactive');
  });

  it('leaves an already-inactive organization archivable (idempotent re-archive)', async () => {
    await reset([]);
    await archiveAsAdmin();
    expect(await statusOf(ORG)).toBe('inactive');
    // Dependencies appearing later must not make a NO-OP re-archive throw.
    await asAdmin(
      `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
       VALUES ($1,$2,'W201b','مخزن','institution',false,'active')`, [randomUUID(), ORG]);
    await archiveAsAdmin();
    expect(await statusOf(ORG)).toBe('inactive');
  });

  it('does not interfere with unrelated column updates on a dependency-holding org', async () => {
    await reset(['warehouses']);
    await asAdmin(`UPDATE organizations SET city='Hillah' WHERE id=$1`, [ORG]);
    expect((await asAdmin(`SELECT city FROM organizations WHERE id=$1`, [ORG])).rows[0].city).toBe('Hillah');
    expect(await statusOf(ORG)).toBe('active');
  });

  it('does not interfere with suspension', async () => {
    await reset(['warehouses']);
    await asAdmin(`UPDATE organizations SET status='suspended' WHERE id=$1`, [ORG]);
    expect(await statusOf(ORG)).toBe('suspended');
    // ...and archiving from suspended is still guarded.
    const err = await rejects(archiveAsAdmin);
    expect(err.message).toContain(BLOCKED);
    expect(await statusOf(ORG)).toBe('suspended');
  });

  it('leaves the pre-existing activation guard intact', async () => {
    const present = await asAdmin(
      `SELECT count(*)::int n FROM pg_trigger
        WHERE tgrelid='public.organizations'::regclass AND NOT tgisinternal
          AND tgname='organizations_health_sector_activation_guard_trg'`);
    expect(present.rows[0].n).toBe(1);
  });

  // ── authorization is unchanged ────────────────────────────────────────────
  it('still refuses an unauthorized actor, and refuses an authorized one when dependencies exist', async () => {
    await reset(['warehouses']);

    const outsider = randomUUID();
    await asAdmin(
      `INSERT INTO auth.users (id,email) VALUES ($1,'outsider201@rig.local')
       ON CONFLICT (id) DO NOTHING`, [outsider]);
    await asAdmin(
      `INSERT INTO profiles (id,organization_id,full_name,role,status,login_mode)
       VALUES ($1,$2,'Outsider201','institution_admin','active','email')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, organization_id=EXCLUDED.organization_id`,
      [outsider, ORG]);

    // Unauthorized: RLS refuses the row outright — zero rows updated, no throw.
    const denied = await rig.asUser(outsider, (c: any) =>
      c.query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG]));
    expect(denied.rowCount).toBe(0);
    expect(await statusOf(ORG)).toBe('active');

    // Authorized super_admin, dependencies present: the guard refuses.
    const err = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
      c.query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG])));
    expect(err.message).toContain(BLOCKED);
    expect(await statusOf(ORG)).toBe('active');
  });

  // ── concurrency ───────────────────────────────────────────────────────────
  it('decides the archive against a true count, never a stale one', async () => {
    // This is the property the fence buys, stated exactly. It is NOT the
    // stronger claim that an archived organization can never come to hold a
    // live dependency - see KNOWN RESIDUAL in the migration header, and the
    // test immediately below, which pins the residual honestly rather than
    // leaving it undocumented.
    await reset([]);
    expect(await statusOf(ORG)).toBe('active');

    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG]);

      // B's foreign key needs FOR KEY SHARE on the organization row, which
      // conflicts with the guard's FOR UPDATE fence, so B cannot commit a
      // dependency behind the archive's back while the decision is being made.
      const newWh = randomUUID();
      let bDone = false;
      const bInsert = b
        .query(
          `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
           VALUES ($1,$2,'W201race','W','institution',false,'active')`, [newWh, ORG])
        .then(() => { bDone = true; })
        .catch(() => { bDone = true; });

      await new Promise((r) => setTimeout(r, 750));
      expect(bDone).toBe(false); // proved blocked, not merely slow-by-luck

      await a.query('COMMIT');
      await bInsert;
      expect(await statusOf(ORG)).toBe('inactive');

      // The guard is still armed against the NEXT archive: B's warehouse is
      // committed and visible now, so re-archiving is refused.
      await asAdmin(`UPDATE organizations SET status='active' WHERE id=$1`, [ORG]);
      const err = await rejects(archiveAsAdmin);
      expect(err.message).toContain(BLOCKED);
      expect(await statusOf(ORG)).toBe('active');
    } finally {
      try { await a.query('ROLLBACK'); } catch { /* already committed */ }
      a.release();
      b.release();
    }
  });

  it('PINS THE KNOWN RESIDUAL: a write landing after the archive is not stopped', async () => {
    // Deliberately asserts the CURRENT, imperfect behaviour so that it is
    // visible and cannot regress silently. A reciprocal child-side rule would
    // close this, but status='inactive' means both 'archived' and 'built, not
    // yet activated', and migration 181 depends on the second meaning:
    // 181-closure-round1 inserts ACTIVE warehouses under an INACTIVE org on
    // purpose. Closing this needs a data-model change (an explicit archived
    // marker), which is out of ISW1-D1's scope.
    //
    // If a future migration adds that marker, THIS test is the one to flip.
    await reset([]);
    await archiveAsAdmin();
    expect(await statusOf(ORG)).toBe('inactive');

    // qr_tokens is the sharpest case: an in-place status flip changes no
    // foreign key, so nothing locks or consults the organization at all.
    const qt = randomUUID();
    const qk = randomUUID();
    const wh = randomUUID();
    const dp = randomUUID();
    await asAdmin(`UPDATE organizations SET status='active' WHERE id=$1`, [ORG]);
    await asAdmin(
      `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
       VALUES ($1,$2,'W201res','W','institution',false,'archived')`, [wh, ORG]);
    await asAdmin(
      `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
       VALUES ($1,$2,$3,'P201res','P','pharmacy','archived')`, [dp, wh, ORG]);
    await asAdmin(
      `INSERT INTO qr_targets (id,organization_id,target_type,target_id,label,status)
       VALUES ($1,$2,'distribution_point',$3,'Q201res','active')`, [qt, ORG, dp]);
    await asAdmin(
      `INSERT INTO qr_tokens (id,qr_target_id,organization_id,public_id,token_hash,status)
       VALUES ($1,$2,$3,'res' || substr(md5(random()::text),1,13), encode(digest('res','sha256'),'hex'),'disabled')`,
      [qk, qt, ORG]);
    await archiveAsAdmin(); // legal: nothing is live
    expect(await statusOf(ORG)).toBe('inactive');

    // Documented gap: this currently SUCCEEDS.
    await asAdmin(`UPDATE qr_tokens SET status='active' WHERE id=$1`, [qk]);
    const live = await asAdmin(
      `SELECT count(*)::int n FROM qr_tokens WHERE organization_id=$1 AND status='active'`, [ORG]);
    expect(live.rows[0].n).toBe(1);
    expect(await statusOf(ORG)).toBe('inactive');

    // What DOES hold: the organization can never be archived AGAIN while that
    // token is live, so the gate itself never decides on a stale count.
    await asAdmin(`UPDATE organizations SET status='active' WHERE id=$1`, [ORG]);
    const err = await rejects(archiveAsAdmin);
    expect(err.message).toContain(BLOCKED);
    expect(await statusOf(ORG)).toBe('active');
  });
  it('the reverse interleaving is refused: a dependency committed first blocks the archive', async () => {
    await reset([]);
    const newWh = randomUUID();
    await asAdmin(
      `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
       VALUES ($1,$2,'W201first','مخزن','institution',false,'active')`, [newWh, ORG]);
    const err = await rejects(archiveAsAdmin);
    expect(err.message).toContain(BLOCKED);
    expect(await statusOf(ORG)).toBe('active');
  });

  it('an untouched organization is unaffected throughout', async () => {
    expect(await statusOf(EMPTY_ORG)).toBe('active');
  });
});
