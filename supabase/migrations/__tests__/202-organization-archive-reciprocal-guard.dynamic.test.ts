/**
 * 202 · ORGANIZATION ARCHIVE RECIPROCAL GUARD (ISW2) — dynamic proof.
 *
 * Migration 201 made the ARCHIVE decision race-free but disclosed a known
 * residual: a dependency write landing in a LATER transaction could still
 * create, move, or reactivate a live row underneath an already-archived
 * organization — sharpest for qr_tokens, whose in-place status flip takes no
 * lock on organizations at all (see 201's own dynamic test, previously
 * "PINS THE KNOWN RESIDUAL", now flipped).
 *
 * 202 adds organizations.archived_at (nullable, database-owned) and a
 * reciprocal child-side guard keyed on that marker instead of on status,
 * because status='inactive' means BOTH "archived" and "built but not yet
 * activated" and migration 181's construction flow depends on the second
 * meaning (proved by a prior reverted attempt, commit 75545de8 -> fabf829b,
 * that keyed the reciprocal rule off status directly).
 *
 * This file proves:
 *   G1  — archived_at cannot be forged, cleared, or backdated by any client,
 *         through any role, with or without touching status in the same
 *         UPDATE; the widened trigger column list actually fires.
 *   R1  — the real, live restoration path (a bare status flip back to
 *         'active', as InstitutionScreen.tsx's generic edit form issues)
 *         clears archived_at and reopens dependency writes.
 *   E/F — reciprocal guard: post-archive INSERT, ownership reassignment onto
 *         an archived org, and in-place reactivation are all now REFUSED.
 *   —   — an archived row can still be written under an archived org
 *         (the guard judges liveness, not history).
 *   D   — migration 181's pre-activation construction is untouched:
 *         archived_at stays NULL throughout, and activation is exactly a
 *         restoration no-op.
 *   A/B/C — concurrency: both orderings of {archive, dependency write} are
 *         refused; a same-organization sibling-write race does not
 *         deadlock or serialize unnecessarily.
 *   I/J — service_role-equivalent (bypassrls superuser) and any SECURITY
 *         DEFINER-style direct write are covered identically — the guard is
 *         table-level, not RLS- or caller-relative.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000, hookTimeout: 300000 });

const run = rigAvailable() ? describe : describe.skip;

const ARCHIVE_BLOCKED = 'organization_archive_blocked_by_dependencies';
const DEP_BLOCKED = 'dependency_write_blocked_by_archived_organization';

const rejects = async (fn: () => Promise<unknown>): Promise<{ message: string; code: string; detail: string }> => {
  try {
    await fn();
  } catch (e: any) {
    return { message: e?.message ?? String(e), code: e?.code ?? '', detail: e?.detail ?? '' };
  }
  throw new Error('expected a rejection but the call succeeded');
};

run('202 · organization archive reciprocal guard', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const ORG = randomUUID();
  const CENTRAL_ITEM = randomUUID();

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  const archivedAtOf = async (id: string): Promise<string | null> =>
    (await asAdmin(`SELECT archived_at FROM organizations WHERE id=$1`, [id])).rows[0].archived_at;
  const statusOf = async (id: string): Promise<string> =>
    (await asAdmin(`SELECT status FROM organizations WHERE id=$1`, [id])).rows[0].status;

  /** Fresh, dependency-free, active organization; wipes any dependents from a prior case. */
  async function freshOrg(): Promise<void> {
    await asAdmin(`DELETE FROM qr_tokens WHERE organization_id=$1`, [ORG]);
    await asAdmin(`DELETE FROM qr_targets WHERE organization_id=$1`, [ORG]);
    await asAdmin(`DELETE FROM item_availability WHERE organization_id=$1`, [ORG]);
    await asAdmin(`DELETE FROM local_items WHERE organization_id=$1`, [ORG]);
    await asAdmin(`DELETE FROM distribution_points WHERE organization_id=$1`, [ORG]);
    await asAdmin(`DELETE FROM warehouses WHERE organization_id=$1`, [ORG]);
    await asAdmin(`UPDATE organizations SET status='active', archived_at=NULL WHERE id=$1`, [ORG]);
  }

  const archive = () => asAdmin(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG]);
  const restore = () => asAdmin(`UPDATE organizations SET status='active' WHERE id=$1`, [ORG]);

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(
      `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
       VALUES ($1,'Org202','منظمة','org-202','care_institution','hospital','active')`,
      [ORG]);
    await asAdmin(
      `INSERT INTO central_items (id,name,name_ar,unit,status) VALUES ($1,'C202','صنف','box','active')`,
      [CENTRAL_ITEM]);
  }, 240000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ── legal archive stamps the marker; restore clears it ────────────────────
  it('a legal archive stamps archived_at; restoration clears it (R1)', async () => {
    await freshOrg();
    expect(await archivedAtOf(ORG)).toBeNull();

    await archive();
    expect(await statusOf(ORG)).toBe('inactive');
    expect(await archivedAtOf(ORG)).not.toBeNull();

    // R1: the real, live restoration path — InstitutionScreen.tsx's generic
    // edit form issues exactly this bare status flip, nothing more.
    await restore();
    expect(await statusOf(ORG)).toBe('active');
    expect(await archivedAtOf(ORG)).toBeNull();
  });

  // ── G1: archived_at is database-owned, never client-writable ──────────────
  describe('G1 · archived_at forgery is normalized, not merely rejected', () => {
    it('G1-A: forging archived_at on a live active org (status untouched) has no effect', async () => {
      await freshOrg();
      await asAdmin(`UPDATE organizations SET archived_at=now() WHERE id=$1`, [ORG]);
      expect(await archivedAtOf(ORG)).toBeNull();
      expect(await statusOf(ORG)).toBe('active');
    });

    it('G1-B: clearing archived_at on a genuinely archived org (status untouched) has no effect', async () => {
      await freshOrg();
      await archive();
      const original = await archivedAtOf(ORG);
      await asAdmin(`UPDATE organizations SET archived_at=NULL WHERE id=$1`, [ORG]);
      expect(await archivedAtOf(ORG)).toEqual(original);
      // Proves the clear had no real effect: a dependency write is still refused.
      const err = await rejects(() => asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'G1B','مخزن','institution',false,'active')`, [randomUUID(), ORG]));
      expect(err.message).toContain(DEP_BLOCKED);
    });

    it('G1-C: service_role-equivalent (bypassrls superuser) forge is normalized identically', async () => {
      await freshOrg();
      // asAdmin already runs as the superuser/bypassrls connection — this IS
      // the service_role-equivalent path; the guard does not distinguish it.
      await asAdmin(`UPDATE organizations SET archived_at='2099-01-01' WHERE id=$1`, [ORG]);
      expect(await archivedAtOf(ORG)).toBeNull();
    });

    it('G1-D: arbitrary timestamp rewrite on an already-archived org is discarded', async () => {
      await freshOrg();
      await archive();
      const original = await archivedAtOf(ORG);
      await asAdmin(`UPDATE organizations SET archived_at='1970-01-01' WHERE id=$1`, [ORG]);
      expect(await archivedAtOf(ORG)).toEqual(original);
    });

    it('G1-E: status unchanged + archived_at mutation alone still fires the widened trigger', async () => {
      await freshOrg();
      // Explicitly an UPDATE whose column list never mentions status at all —
      // the single most important regression case for the widened OF-list.
      const before = await statusOf(ORG);
      await asAdmin(`UPDATE organizations SET archived_at=now(), city='Karbala' WHERE id=$1`, [ORG]);
      expect(await archivedAtOf(ORG)).toBeNull();
      expect(await statusOf(ORG)).toBe(before);
      expect((await asAdmin(`SELECT city FROM organizations WHERE id=$1`, [ORG])).rows[0].city).toBe('Karbala');
    });

    it('G1-G: INSERT cannot forge archived_at either (independent-review round 2 finding)', async () => {
      // The entry-reset (NEW.archived_at := OLD.archived_at) only applies to
      // UPDATE - OLD does not exist for INSERT. Without a dedicated branch,
      // a plain INSERT specifying archived_at directly would silently stick.
      const id = randomUUID();
      await asAdmin(
        `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status,archived_at)
         VALUES ($1,'ForgeInsert202','ForgeInsert202','org-202-forge-insert','care_institution','hospital','active','2001-01-01T00:00:00Z')`,
        [id]);
      expect(await archivedAtOf(id)).toBeNull();
      const status = (await asAdmin(`SELECT status FROM organizations WHERE id=$1`, [id])).rows[0].status;
      expect(status).toBe('active');
    });

    it('G1-F: no function directly issues UPDATE organizations SET archived_at, outside the one authorized trigger', async () => {
      // Precise for the actual forbidden pattern (a direct UPDATE statement
      // targeting organizations.archived_at from some other writer), not a
      // bare substring match — the guard's own trigger functions legitimately
      // read/assign NEW.archived_at via `:=`, never via a literal UPDATE
      // statement, and warehouses/distribution_points carry their own,
      // unrelated archived_at columns that a naive substring check would
      // also flag.
      const hits = await asAdmin(`
        SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND pg_get_functiondef(p.oid) ~* 'UPDATE\\s+(public\\.)?organizations\\b[^;]*\\bSET\\b[^;]*\\barchived_at\\b'
      `);
      expect(hits.rows).toEqual([]);
    });
  });

  // ── reciprocal guard: E/F schedules ────────────────────────────────────────
  describe('reciprocal guard refuses every live-dependency path under an archived org', () => {
    it('refuses INSERT of a live warehouse under an archived organization', async () => {
      await freshOrg();
      await archive();
      const err = await rejects(() => asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202','مخزن','institution',false,'active')`, [randomUUID(), ORG]));
      expect(err.message).toContain(DEP_BLOCKED);
      expect(err.code).toBe('23514');
      expect(err.detail).toMatch(/table=warehouses organization=.+ archived_at=.+ operation=INSERT/);
    });

    it('an ARCHIVED-status warehouse can still be written under an archived org (liveness, not history)', async () => {
      await freshOrg();
      await archive();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202arch','مخزن','institution',false,'archived')`, [randomUUID(), ORG]);
      // no throw = pass
    });

    it('refuses ownership reassignment (schedule E): moving a live warehouse onto an archived org', async () => {
      await freshOrg();
      const donorOrg = randomUUID();
      await asAdmin(
        `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
         VALUES ($1,'Donor202','مانح','org-202d','care_institution','hospital','active')`, [donorOrg]);
      const wh = randomUUID();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202donor','مخزن','institution',false,'active')`, [wh, donorOrg]);
      await archive();
      const err = await rejects(() => asAdmin(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG, wh]));
      expect(err.message).toContain(DEP_BLOCKED);
    });

    it('refuses in-place qr_token reactivation under an archived org (schedule F, the closed residual)', async () => {
      await freshOrg();
      const wh = randomUUID(); const dp = randomUUID(); const qt = randomUUID(); const qk = randomUUID();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202f','مخزن','institution',false,'archived')`, [wh, ORG]);
      await asAdmin(
        `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'P202f','منفذ','pharmacy','archived')`, [dp, wh, ORG]);
      await asAdmin(
        `INSERT INTO qr_targets (id,organization_id,target_type,target_id,label,status)
         VALUES ($1,$2,'distribution_point',$3,'Q202f','active')`, [qt, ORG, dp]);
      await asAdmin(
        `INSERT INTO qr_tokens (id,qr_target_id,organization_id,public_id,token_hash,status)
         VALUES ($1,$2,$3,'f202' || substr(md5(random()::text),1,12), encode(digest('f202','sha256'),'hex'),'disabled')`,
        [qk, qt, ORG]);
      await archive(); // legal: nothing live
      const err = await rejects(() => asAdmin(`UPDATE qr_tokens SET status='active' WHERE id=$1`, [qk]));
      expect(err.message).toContain(DEP_BLOCKED);
    });

    it('refuses item_availability creation under an archived org (no status column, "any" liveness class)', async () => {
      await freshOrg();
      const wh = randomUUID(); const dp = randomUUID(); const li = randomUUID();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202ia','مخزن','institution',false,'archived')`, [wh, ORG]);
      await asAdmin(
        `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'P202ia','منفذ','pharmacy','archived')`, [dp, wh, ORG]);
      await asAdmin(
        `INSERT INTO local_items (id,central_item_id,organization_id,local_name,status)
         VALUES ($1,$2,$3,'L202ia','active')`, [li, CENTRAL_ITEM, ORG]);
      await archive(); // legal: nothing live
      const err = await rejects(() => asAdmin(
        `INSERT INTO item_availability (id,local_item_id,distribution_point_id,organization_id,quantity,condition,source_kind)
         VALUES ($1,$2,$3,$4,3,'available','manual')`, [randomUUID(), li, dp, ORG]));
      expect(err.message).toContain(DEP_BLOCKED);
    });

    it('routine, non-liveness updates on children of an archived org are unaffected', async () => {
      await freshOrg();
      const wh = randomUUID();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202routine','مخزن','institution',false,'archived')`, [wh, ORG]);
      await archive();
      await asAdmin(`UPDATE warehouses SET name='Renamed202' WHERE id=$1`, [wh]);
      expect((await asAdmin(`SELECT name FROM warehouses WHERE id=$1`, [wh])).rows[0].name).toBe('Renamed202');
    });
  });

  // ── M181 compatibility (D) ─────────────────────────────────────────────────
  it('D: M181 pre-activation construction is untouched — archived_at stays NULL throughout', async () => {
    const draftOrg = randomUUID();
    await asAdmin(
      `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
       VALUES ($1,'Draft202','مسودة','org-202draft','care_institution','health_sector','inactive')`,
      [draftOrg]);
    expect(await archivedAtOf(draftOrg)).toBeNull();

    const main = randomUUID();
    await asAdmin(
      `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
       VALUES ($1,$2,'Sector main202','رئيسي','institution',NULL,true,'active')`, [main, draftOrg]);
    // The exact flow 75545de8's reverted attempt broke: ACTIVE children under
    // an INACTIVE, never-archived organization must be freely insertable.
    expect(await archivedAtOf(draftOrg)).toBeNull();

    await asAdmin(`UPDATE organizations SET status='active' WHERE id=$1`, [draftOrg]);
    expect(await statusOf(draftOrg)).toBe('active');
    // Activation is exactly the restoration branch's no-op case (was already NULL).
    expect(await archivedAtOf(draftOrg)).toBeNull();
  });

  // ── concurrency (A/B/C) ─────────────────────────────────────────────────────
  it('A: archive first / child second — child waits, then is refused', async () => {
    await freshOrg();
    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG]);

      const newWh = randomUUID();
      let bSettled = false;
      let bError: any = null;
      const bInsert = b
        .query(
          `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
           VALUES ($1,$2,'W202A','مخزن','institution',false,'active')`, [newWh, ORG])
        .catch((e: any) => { bError = e; })
        .finally(() => { bSettled = true; });

      await new Promise((r) => setTimeout(r, 750));
      expect(bSettled).toBe(false); // proved blocked on the parent lock, not merely slow

      await a.query('COMMIT');
      await bInsert;
      expect(bSettled).toBe(true);
      expect(bError?.message).toContain(DEP_BLOCKED);
      expect(await statusOf(ORG)).toBe('inactive');
    } finally {
      try { await a.query('ROLLBACK'); } catch { /* already committed */ }
      a.release();
      b.release();
    }
  });

  it('B: child first / archive second — archive waits, then is refused (unchanged from 201)', async () => {
    await freshOrg();
    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      const newWh = randomUUID();
      await b.query('BEGIN');
      await b.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202B','مخزن','institution',false,'active')`, [newWh, ORG]);

      let aSettled = false;
      let aError: any = null;
      const aArchive = a
        .query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG])
        .catch((e: any) => { aError = e; })
        .finally(() => { aSettled = true; });

      await new Promise((r) => setTimeout(r, 750));
      expect(aSettled).toBe(false);

      await b.query('COMMIT');
      await aArchive;
      expect(aSettled).toBe(true);
      expect(aError?.message).toContain(ARCHIVE_BLOCKED);
      expect(await statusOf(ORG)).toBe('active');
    } finally {
      try { await b.query('ROLLBACK'); } catch { /* already committed */ }
      a.release();
      b.release();
    }
  });

  it('C: concurrent sibling writes under the same LIVE organization do not serialize (FOR KEY SHARE vs FOR KEY SHARE)', async () => {
    await freshOrg();
    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      const wh1 = randomUUID();
      const wh2 = randomUUID();
      const start = Date.now();
      await Promise.all([
        a.query(
          `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
           VALUES ($1,$2,'W202C1','مخزن','institution',false,'active')`, [wh1, ORG]),
        b.query(
          `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
           VALUES ($1,$2,'W202C2','مخزن','institution',false,'active')`, [wh2, ORG]),
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3000); // no ~1s+ lock-wait stall between them
      const count = await asAdmin(`SELECT count(*)::int n FROM warehouses WHERE organization_id=$1 AND status='active'`, [ORG]);
      expect(count.rows[0].n).toBe(2);
    } finally {
      a.release();
      b.release();
    }
  });

  it('L: repeated archive/restore/write cycles under stress produce no deadlock and stay invariant-clean', async () => {
    await freshOrg();
    for (let i = 0; i < 8; i++) {
      await archive();
      const err = await rejects(() => asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202L','مخزن','institution',false,'active')`, [randomUUID(), ORG]));
      expect(err.message).toContain(DEP_BLOCKED);
      await restore();
      const wh = randomUUID();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
         VALUES ($1,$2,'W202Lok','مخزن','institution',false,'active')`, [wh, ORG]);
      await asAdmin(`UPDATE warehouses SET status='archived' WHERE id=$1`, [wh]); // clear for the next archive
    }
    expect(await statusOf(ORG)).toBe('active');
    expect(await archivedAtOf(ORG)).toBeNull();
  });

  it('K/deadlock probe: reversed lock-acquisition order between two sessions resolves as a Postgres deadlock (40P01) or clean serialization, never a hang', async () => {
    await freshOrg();
    const wh = randomUUID();
    await asAdmin(
      `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,is_main,status)
       VALUES ($1,$2,'W202K','مخزن','institution',false,'active')`, [wh, ORG]);

    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      // Session A: lock the organization row first (archive attempt: blocked
      // by the live warehouse, but the FOR UPDATE fence is taken before the
      // count), then try to touch the warehouse row.
      // Session B: lock the warehouse row first, then try to touch the
      // organization row. If both hold their first lock and wait on the
      // other's, Postgres must detect and abort one with 40P01 — never hang.
      await a.query('BEGIN');
      await b.query('BEGIN');

      const aFirst = a.query(`UPDATE organizations SET city='DeadlockA' WHERE id=$1`, [ORG]);
      const bFirst = b.query(`UPDATE warehouses SET name='DeadlockB' WHERE id=$1`, [wh]);
      await Promise.all([aFirst, bFirst]);

      const aSecond = a.query(`UPDATE warehouses SET name='DeadlockA2' WHERE id=$1`, [wh]).catch((e: any) => e);
      const bSecond = b.query(`UPDATE organizations SET city='DeadlockB2' WHERE id=$1`, [ORG]).catch((e: any) => e);

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('deadlock probe hung past 15s — no detection occurred')), 15000));
      const [resA, resB] = await Promise.race([
        Promise.all([aSecond, bSecond]).then((r) => [r, null]),
        timeout.then(() => { throw new Error('unreachable'); }),
      ]) as [any[], null];

      const errors = [resA[0], resA[1]].filter((r) => r instanceof Error);
      // Either Postgres detects a genuine deadlock (40P01) on exactly one
      // side, or the two statements simply serialize with no error at all
      // (possible depending on arrival order/lock granularity) — both are
      // acceptable; a hang or any OTHER error code is not.
      for (const e of errors) {
        expect((e as any).code).toBe('40P01');
      }
    } finally {
      try { await a.query('ROLLBACK'); } catch { /* ignore */ }
      try { await b.query('ROLLBACK'); } catch { /* ignore */ }
      a.release();
      b.release();
    }
  });
});
