import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000, hookTimeout: 420000 });
const run = rigAvailable() ? describe : describe.skip;

const A = '00000000-0000-0000-0000-000000187001';
const B = '00000000-0000-0000-0000-000000187002';
const C = '00000000-0000-0000-0000-000000187003';
const D = '00000000-0000-0000-0000-000000187004';
const WA = '00000000-0000-0000-0000-000000187101';
const WB = '00000000-0000-0000-0000-000000187102';
const WB2 = '00000000-0000-0000-0000-000000187103';
const PA = '00000000-0000-0000-0000-000000187201';
const PB = '00000000-0000-0000-0000-000000187202';
const STOCK_B = '00000000-0000-0000-0000-000000187220';
const SUPER = '00000000-0000-0000-0000-000000187301';
const WO = '00000000-0000-0000-0000-000000187302';
const OO = '00000000-0000-0000-0000-000000187303';
const IA = '00000000-0000-0000-0000-000000187304';
const HCM = '00000000-0000-0000-0000-000000187305';
// Fresh actors for the isolation proofs below, so no scope granted by an
// earlier test in this file can mask a missing denial.
const WO2 = '00000000-0000-0000-0000-000000187306';
const OO2 = '00000000-0000-0000-0000-000000187307';
// Eligible ROLE, active status, but NO primary organization anchor.
const NOORG = '00000000-0000-0000-0000-000000187308';
const PB2 = '00000000-0000-0000-0000-000000187203';
const STOCK_B2 = '00000000-0000-0000-0000-000000187221';

run('187 delegated operational access — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let warehouseAssignment = '';
  let networkGroup = '';
  const admin = (sql: string, params: unknown[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const rpc = (user: string, fn: string, args: unknown[] = []) => rig.asUser(user, async (c: any) => {
    await c.query(`SET LOCAL statement_timeout='15s'`);
    return c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args)
      .then((r: any) => r.rows[0].r);
  }, { commit: true });
  const allowed = (profile: string, key: string, org: string, wh: string | null, point: string | null) =>
    admin('SELECT public.phoenix_profile_has_scoped_permission($1,$2,$3,$4,$5) AS allowed',
      [profile, key, org, wh, point]).then((r: any) => r.rows[0].allowed as boolean);
  const rejects = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (error: any) { return `${error.code ?? ''}:${error.message}`; }
    throw new Error('expected rejection');
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await admin(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${A}','M187 A','م ١٨٧ أ','m187-a','care_institution','hospital','active'),
        ('${B}','M187 B','م ١٨٧ ب','m187-b','care_institution','hospital','active'),
        ('${C}','M187 C','م ١٨٧ ج','m187-c','care_institution','health_sector','active');
      INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,is_main,status,code) VALUES
        ('${WA}','${A}','A warehouse','مخزن أ','institution',true,'active','m187-wa'),
        ('${WB}','${B}','B warehouse','مخزن ب','institution',true,'active','m187-wb'),
        ('${WB2}','${B}','B sibling','مخزن ب ٢','institution',false,'active','m187-wb2');
      INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status) VALUES
        ('${PA}','${A}','${WA}','A outlet','منفذ أ','pharmacy','active'),
        ('${PB}','${B}','${WB}','B outlet','منفذ ب','pharmacy','active'),
        ('${PB2}','${B}','${WB}','B sibling outlet','منفذ ب ٢','pharmacy','active');
      INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,
        has_no_national_code,has_no_batch_number,batch_number,on_hand_quantity,reserved_quantity,movement_seq)
      VALUES ('${STOCK_B}','${B}','${WB}','M187 delegated mutation',true,false,'M187-B',50,0,0),
             ('${STOCK_B2}','${B}','${WB}','M187 zero delta probe',true,false,'M187-B2',40,0,0);
      INSERT INTO auth.users(id,email) VALUES
        ('${SUPER}','m187-super@rig.local'),('${WO}','m187-wo@rig.local'),
        ('${OO}','m187-oo@rig.local'),('${IA}','m187-ia@rig.local'),('${HCM}','m187-hcm@rig.local'),
        ('${WO2}','m187-wo2@rig.local'),('${OO2}','m187-oo2@rig.local'),
        ('${NOORG}','m187-noorg@rig.local');
      UPDATE profiles SET role='super_admin',status='active',organization_id=NULL WHERE id='${SUPER}';
      UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${A}' WHERE id='${WO}';
      UPDATE profiles SET role='outlet_officer',status='active',organization_id='${A}' WHERE id='${OO}';
      UPDATE profiles SET role='institution_admin',status='active',organization_id='${A}' WHERE id='${IA}';
      UPDATE profiles SET role='health_center_manager',status='active',organization_id='${C}' WHERE id='${HCM}';
      UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${A}' WHERE id='${WO2}';
      UPDATE profiles SET role='outlet_officer',status='active',organization_id='${A}' WHERE id='${OO2}';
      UPDATE profiles SET role='warehouse_officer',status='active',organization_id=NULL WHERE id='${NOORG}';
      INSERT INTO profile_scope_assignments(profile_id,organization_id,scope_type,warehouse_id,is_active)
        VALUES ('${WO}','${A}','warehouse','${WA}',true);
      INSERT INTO profile_scope_assignments(profile_id,organization_id,scope_type,distribution_point_id,is_active)
        VALUES ('${OO}','${A}','distribution_point','${PA}',true);
    `);
  });

  afterAll(async () => { if (rig) await rig.end(); });

  it('preserves same-org parity and denies permission without foreign scope', async () => {
    expect(await allowed(WO, 'warehouse_stock.view', A, WA, null)).toBe(true);
    expect(await allowed(WO, 'warehouse_stock.view', B, WB, null)).toBe(false);
    expect(await allowed(OO, 'outlet_stock.view', A, null, PA)).toBe(true);
    expect(await allowed(OO, 'outlet_stock.view', B, null, PB)).toBe(false);
  });

  it('denies direct writes, self-grants, institution grants, and ineligible recipients', async () => {
    const direct = await rejects(() => rig.asUser(WO, c => c.query(
      `INSERT INTO profile_delegated_scope_assignments
       (profile_id,target_organization_id,scope_type,include_child_outlets,grant_group_id,grant_origin,assigned_by)
       VALUES ($1,$2,'organization',false,gen_random_uuid(),'direct',$1)`, [WO, B]), { commit: true }));
    expect(direct).toMatch(/permission denied/);
    for (const statement of [
      `UPDATE profile_delegated_scope_assignments SET include_child_outlets=true WHERE id=gen_random_uuid()`,
      `DELETE FROM profile_delegated_scope_assignments WHERE id=gen_random_uuid()`,
    ]) {
      expect(await rejects(() => rig.asUser(WO, c => c.query(statement), { commit: true })))
        .toMatch(/permission denied/);
    }
    for (const actor of [WO, IA]) {
      expect(await rejects(() => rpc(actor, 'phoenix_admin_grant_delegated_scope', [WO, B, 'organization', null, null, false])))
        .toContain('delegated_scope_request_denied');
    }
    for (const target of [HCM, IA, SUPER]) {
      expect(await rejects(() => rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [target, B, 'organization', null, null, false])))
        .toContain('delegated_scope_recipient_ineligible');
    }
  });

  it('grants only the exact warehouse and keeps child inheritance false', async () => {
    const result = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO, B, 'warehouse', WB, null, false]);
    warehouseAssignment = result.assignment_id;
    expect(await allowed(WO, 'warehouse_stock.view', B, WB, null)).toBe(true);
    expect(await allowed(WO, 'warehouse_stock.view', B, WB2, null)).toBe(false);
    expect(await allowed(WO, 'outlet_stock.view', B, null, PB)).toBe(false);
    const conflict = await rejects(() => rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO, B, 'warehouse', WB, null, true]));
    expect(conflict).toContain('delegated_scope_active_conflict');
  });

  it('scope without WHAT stays denied; canonical permission override enables inherited child and removal denies again', async () => {
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope', [warehouseAssignment, null, 'replace with explicit child inheritance']);
    const result = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO, B, 'warehouse', WB, null, true]);
    warehouseAssignment = result.assignment_id;
    await rpc(SUPER, 'assign_profile_permissions', [WO, { 'outlet_stock.view': false }]);
    expect(await allowed(WO, 'outlet_stock.view', B, null, PB)).toBe(false);
    const granted = await rpc(SUPER, 'assign_profile_permissions', [WO, { 'outlet_stock.view': true }]);
    expect(granted.applied).toBe(1);
    expect(await allowed(WO, 'outlet_stock.view', B, null, PB)).toBe(true);
    await rpc(SUPER, 'assign_profile_permissions', [WO, { 'outlet_stock.view': false }]);
    expect(await allowed(WO, 'outlet_stock.view', B, null, PB)).toBe(false);

    const movement = await rpc(WO, 'phoenix_apply_warehouse_stock_movement_guarded',
      [randomUUID(), STOCK_B, 'correction', 49, 'delegated physical count', 0, null, null]);
    expect(movement.ok).toBe(true);
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [warehouseAssignment, null, 'custody delegation expired']);
    expect(await rejects(() => rpc(WO, 'phoenix_apply_warehouse_stock_movement_guarded',
      [randomUUID(), STOCK_B, 'correction', 48, 'must now fail', 1, null, null])))
      .toMatch(/forbidden|permission|scope/i);
  });

  it('organization scope covers B but not C and the exact firewall denies administrative keys', async () => {
    await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [OO, B, 'organization', null, null, false]);
    expect(await allowed(OO, 'outlet_stock.view', B, null, PB)).toBe(true);
    expect(await allowed(OO, 'outlet_stock.view', C, null, null)).toBe(false);
    await rpc(SUPER, 'assign_profile_permissions', [OO, { 'users.edit_scope': true }]);
    expect(await allowed(OO, 'users.edit_scope', B, null, null)).toBe(false);
  });

  it('network snapshot is current-only and group revoke is immediate', async () => {
    const [first, replay] = await Promise.all([
      rpc(SUPER, 'phoenix_admin_grant_delegated_network_snapshot', [WO]),
      rpc(SUPER, 'phoenix_admin_grant_delegated_network_snapshot', [WO]),
    ]);
    expect(first.grant_group_id).toBe(replay.grant_group_id);
    expect([first.assignments_created,replay.assignments_created].sort((a,b) => a-b)).toEqual([0,first.organization_count]);
    networkGroup = first.grant_group_id;
    expect(first.organization_count).toBeGreaterThanOrEqual(2);
    // The snapshot is FOREIGN-only: the recipient's OWN organization is never
    // delegated to itself, exactly as the direct grant refuses it. A same-org
    // row would be inert at the authorization helper but would still make the
    // resource catalog fan out over the recipient's whole primary organization.
    const ownOrg = await admin(`SELECT count(*)::int n FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND target_organization_id=$2`, [WO, A]);
    expect(ownOrg.rows[0].n).toBe(0);
    // The retired origin is refused by the CHECK itself, not merely absent
    // from the source text — a future refresh mode needs its own migration.
    expect(await rejects(() => admin(
      `INSERT INTO profile_delegated_scope_assignments
       (profile_id,target_organization_id,scope_type,include_child_outlets,grant_group_id,grant_origin)
       VALUES ($1,$2,'organization',false,gen_random_uuid(),'network_refresh')`, [WO, C])))
      .toMatch(/pdsa_grant_origin_chk|violates check constraint/i);
    const catalogOwnOrgWarehouses = await rig.asUser(WO, (c: any) =>
      c.query(`SELECT count(*)::int n FROM public.phoenix_my_operational_resource_catalog()
                WHERE organization_id=$1 AND scope_source='delegated'`, [A])
        .then((r: any) => r.rows[0].n));
    expect(catalogOwnOrgWarehouses).toBe(0);
    const snapshotAudit = await admin(`SELECT count(*)::int n FROM audit_logs
      WHERE action='delegated_scope_assigned' AND payload->>'grant_group_id'=$1
        AND payload->>'grant_origin'='network_snapshot'`, [networkGroup]);
    expect(snapshotAudit.rows[0].n).toBe(first.organization_count);
    expect(await allowed(WO, 'warehouse_stock.view', C, null, null)).toBe(true);
    await admin(`INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES ($1,'M187 D','م ١٨٧ د','m187-d','care_institution','hospital','active')`, [D]);
    expect(await allowed(WO, 'warehouse_stock.view', D, null, null)).toBe(false);
    const revocations = await Promise.all([
      rpc(SUPER, 'phoenix_admin_revoke_delegated_scope', [null, networkGroup, 'network access expired']),
      rpc(SUPER, 'phoenix_admin_revoke_delegated_scope', [null, networkGroup, 'network access expired']),
    ]);
    expect(revocations.reduce((n,r) => n+r.revoked_count,0)).toBeGreaterThanOrEqual(1);
    const revokeAudit = await admin(`SELECT count(*)::int n FROM audit_logs
      WHERE action='delegated_scope_revoked' AND payload->>'grant_group_id'=$1
        AND payload->>'revoke_reason'='network access expired'`, [networkGroup]);
    expect(revokeAudit.rows[0].n).toBe(first.organization_count);
    expect(await allowed(WO, 'warehouse_stock.view', C, null, null)).toBe(false);
  });

  it('does not expose another actor delegated authorization through the public helper', async () => {
    const result = await rig.asUser(OO, c => c.query(
      `SELECT public.phoenix_profile_has_scoped_permission($1,'warehouse_stock.view',$2,NULL,NULL) allowed`,
      [WO, C]).then((r: any) => r.rows[0].allowed));
    expect(result).toBe(false);
  });

  it('serializes concurrent identical grants without duplicate active rows or raw unique errors', async () => {
    const outcomes = await Promise.all([
      rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO, C, 'organization', null, null, false]),
      rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO, C, 'organization', null, null, false]),
    ]);
    expect(outcomes.every(r => r.ok)).toBe(true);
    const count = await admin(`SELECT count(*)::int n FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND target_organization_id=$2 AND scope_type='organization' AND is_active`, [WO, C]);
    expect(count.rows[0].n).toBe(1);
    const audit = await admin(`SELECT count(*)::int n FROM audit_logs
      WHERE action='delegated_scope_assigned' AND payload->>'profile_id'=$1
        AND payload->>'target_organization_id'=$2
        AND payload->>'grant_origin'='direct' AND payload->>'scope_type'='organization'`, [WO, C]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('lifecycle transition revokes and re-enable cannot reactivate stale scope', async () => {
    expect(await allowed(WO, 'warehouse_stock.view', C, null, null)).toBe(true);
    await admin(`UPDATE profiles SET status='suspended' WHERE id=$1`, [WO]);
    expect(await allowed(WO, 'warehouse_stock.view', C, null, null)).toBe(false);
    await admin(`UPDATE profiles SET status='active' WHERE id=$1`, [WO]);
    expect(await allowed(WO, 'warehouse_stock.view', C, null, null)).toBe(false);
    const history = await admin(`SELECT count(*)::int n FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND NOT is_active AND revoke_reason='profile_inactive'`, [WO]);
    expect(history.rows[0].n).toBeGreaterThan(0);
  });

  // An exact point grant is WHERE for that point only. Projecting the point's
  // parent warehouse must NOT make that warehouse, its siblings, or a sibling
  // point under it authorized.
  it('an exact point delegation never implies its parent warehouse or any sibling', async () => {
    await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [OO2, B, 'distribution_point', null, PB, false]);
    await rpc(SUPER, 'assign_profile_permissions',
      [OO2, { 'outlet_stock.view': true, 'warehouse_stock.view': true }]);
    expect(await allowed(OO2, 'outlet_stock.view', B, null, PB)).toBe(true);
    expect(await allowed(OO2, 'warehouse_stock.view', B, WB, null)).toBe(false);
    expect(await allowed(OO2, 'warehouse_stock.view', B, WB2, null)).toBe(false);
    expect(await allowed(OO2, 'outlet_stock.view', B, null, PB2)).toBe(false);
    // The org itself is not implied either: an org-level ask names no resource.
    expect(await allowed(OO2, 'warehouse_stock.view', B, null, null)).toBe(false);
    // The projection may name the parent warehouse for display, but only ever
    // on a row that is itself a point row.
    const rows = await rig.asUser(OO2, (c: any) =>
      c.query(`SELECT warehouse_id, distribution_point_id, scope_source
                 FROM public.phoenix_my_operational_resource_catalog()
                WHERE organization_id=$1`, [B]).then((r: any) => r.rows));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.distribution_point_id === PB)).toBe(true);
    expect(rows.some((r: any) => r.distribution_point_id === null)).toBe(false);
  });

  // WHAT and WHERE must both be present for a REAL canonical mutation, and a
  // denial must leave stock, movement and ledger state byte-identical.
  it('proves WHAT+WHERE on a real mutation with zero delta on every denial', async () => {
    const snapshot = async () => (await admin(
      `SELECT (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1) AS qty,
              (SELECT count(*)::int FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS moves`,
      [STOCK_B2])).rows[0];
    const correct = (qty: number, note: string, seq: number) =>
      rpc(WO2, 'phoenix_apply_warehouse_stock_movement_guarded',
        [randomUUID(), STOCK_B2, 'correction', qty, note, seq, null, null]);

    // 1. WHAT without any delegated WHERE.
    await rpc(SUPER, 'assign_profile_permissions', [WO2, { 'warehouse_stock.correct': true }]);
    const before1 = await snapshot();
    expect(await rejects(() => correct(39, 'no scope', 0))).toMatch(/forbidden|permission|scope/i);
    expect(await snapshot()).toEqual(before1);

    // 2. Delegated WHERE without the WHAT permission.
    await rpc(SUPER, 'assign_profile_permissions', [WO2, { 'warehouse_stock.correct': false }]);
    const grant = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO2, B, 'warehouse', WB, null, false]);
    const before2 = await snapshot();
    expect(await rejects(() => correct(39, 'no permission', 0))).toMatch(/forbidden|permission|scope/i);
    expect(await snapshot()).toEqual(before2);

    // 3. WHAT + exact active delegated WHERE — the real mutation lands.
    await rpc(SUPER, 'assign_profile_permissions', [WO2, { 'warehouse_stock.correct': true }]);
    const ok = await correct(39, 'delegated physical count', 0);
    expect(ok.ok).toBe(true);
    const after3 = await snapshot();
    expect(after3.qty).toBe(39);
    expect(after3.moves).toBe(before2.moves + 1);

    // 4. Revoke the WHERE only — the very same call must fail with zero delta.
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [grant.assignment_id, null, 'zero delta probe complete']);
    expect(await rejects(() => correct(38, 'after revoke', 1))).toMatch(/forbidden|permission|scope/i);
    expect(await snapshot()).toEqual(after3);
  });

  // Role change, identity recycle and delete are separate lifecycle edges from
  // the status edge proven above; each must revoke and none may revive.
  it('revokes on role change, on identity recycle, and on delete', async () => {
    const activeScopes = (profile: string) => admin(
      `SELECT count(*)::int n FROM profile_delegated_scope_assignments
        WHERE profile_id=$1 AND is_active`, [profile]).then((r: any) => r.rows[0].n);

    await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO2, B, 'warehouse', WB, null, false]);
    expect(await activeScopes(WO2)).toBe(1);
    await admin(`UPDATE profiles SET role='outlet_officer' WHERE id=$1`, [WO2]);
    expect(await activeScopes(WO2)).toBe(0);
    // Restoring the eligible role must NOT revive the revoked grant.
    await admin(`UPDATE profiles SET role='warehouse_officer' WHERE id=$1`, [WO2]);
    expect(await activeScopes(WO2)).toBe(0);
    expect(await allowed(WO2, 'warehouse_stock.correct', B, WB, null)).toBe(false);
    expect((await admin(`SELECT count(*)::int n FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND NOT is_active AND revoke_reason='role_changed'`, [WO2])).rows[0].n)
      .toBeGreaterThan(0);

    await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO2, B, 'warehouse', WB, null, false]);
    expect(await activeScopes(WO2)).toBe(1);
    await admin(`UPDATE profiles SET identity_version=identity_version+1 WHERE id=$1`, [WO2]);
    expect(await activeScopes(WO2)).toBe(0);
    expect((await admin(`SELECT count(*)::int n FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND NOT is_active AND revoke_reason='identity_recycled'`, [WO2])).rows[0].n)
      .toBeGreaterThan(0);

    await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [OO2, C, 'organization', null, null, false]);
    expect(await activeScopes(OO2)).toBeGreaterThan(0);
    await admin(`DELETE FROM profiles WHERE id=$1`, [OO2]);
    expect(await activeScopes(OO2)).toBe(0);
  });

  // A revoke committed while a real mutation is in flight must not leave stale
  // authorization behind, and must not deadlock or half-apply the movement.
  it('serializes a real mutation against a concurrent revoke on independent connections', async () => {
    await rpc(SUPER, 'assign_profile_permissions', [WO2, { 'warehouse_stock.correct': true }]);
    const grant = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO2, B, 'warehouse', WB, null, false]);
    const before = (await admin(
      `SELECT on_hand_quantity qty, movement_seq seq FROM warehouse_stock WHERE id=$1`, [STOCK_B2])).rows[0];

    const mutation = rpc(WO2, 'phoenix_apply_warehouse_stock_movement_guarded',
      [randomUUID(), STOCK_B2, 'correction', 37, 'racing the revoke', before.seq, null, null])
      .then(r => ({ committed: true, r })).catch(e => ({ committed: false, e }));
    const revoke = rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [grant.assignment_id, null, 'revoked during a live operation'])
      .then(r => ({ ok: true, r })).catch(e => ({ ok: false, e }));
    const [mutationOutcome, revokeOutcome] = await Promise.all([mutation, revoke]);

    // The revoke itself must always succeed; only the mutation may legitimately
    // land on either side of the boundary.
    expect((revokeOutcome as any).ok).toBe(true);
    const after = (await admin(
      `SELECT on_hand_quantity qty,
              (SELECT count(*)::int FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) moves
         FROM warehouse_stock WHERE id=$1`, [STOCK_B2])).rows[0];
    if ((mutationOutcome as any).committed) {
      expect(after.qty).toBe(37);
    } else {
      expect(after.qty).toBe(before.qty);
      expect(String((mutationOutcome as any).e?.message)).not.toMatch(/deadlock/i);
    }
    // Either way, authority is gone AFTER the boundary and stays gone. Read the
    // CURRENT optimistic-concurrency seq so the retry is rejected on
    // authorization, never on a stale-seq conflict.
    expect(await allowed(WO2, 'warehouse_stock.correct', B, WB, null)).toBe(false);
    const seq = (await admin(`SELECT movement_seq FROM warehouse_stock WHERE id=$1`, [STOCK_B2]))
      .rows[0].movement_seq;
    expect(await rejects(() => rpc(WO2, 'phoenix_apply_warehouse_stock_movement_guarded',
      [randomUUID(), STOCK_B2, 'correction', 30, 'post-revoke', seq, null, null])))
      .toMatch(/forbidden|permission|scope/i);
  });

  // Same-organization primary authorization must be untouched by 187.
  it('leaves same-organization primary authorization unchanged', async () => {
    // institution_admin answers organization-wide inside its OWN organization —
    // on the warehouse branch and on the distribution-point branch alike. Both
    // are asserted with a key this role actually holds, so the assertion proves
    // the org-wide branch rather than the role's default permission set.
    expect(await allowed(IA, 'warehouse_stock.view', A, WA, null)).toBe(true);
    expect(await allowed(IA, 'warehouse_stock.view', A, null, PA)).toBe(true);
    expect(await allowed(IA, 'warehouse_stock.view', A, null, null)).toBe(true);
    // ...and never outside it, delegation or not.
    expect(await allowed(IA, 'warehouse_stock.view', B, WB, null)).toBe(false);
    // warehouse_officer keeps exact-resource semantics in its own org.
    expect(await allowed(WO, 'warehouse_stock.view', A, WA, null)).toBe(true);
    // health_center_manager may only ever ask about itself (182's oracle guard).
    const hcmAboutOther = await rig.asUser(HCM, (c: any) =>
      c.query(`SELECT public.phoenix_profile_has_scoped_permission($1,'warehouse_stock.view',$2,$3,NULL) a`,
        [WO, A, WA]).then((r: any) => r.rows[0].a));
    expect(hcmAboutOther).toBe(false);
    // An HCM is not an eligible delegated recipient at the WHERE bridge either.
    expect(await admin(
      `SELECT public._phoenix_profile_has_delegated_scope_v1($1,$2,NULL,NULL) a`, [HCM, B])
      .then((r: any) => r.rows[0].a)).toBe(false);
  });

  // Real, existing identifiers must not become an existence oracle.
  it('does not leak foreign assignments, grant groups or scope status', async () => {
    const foreign = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [WO, B, 'warehouse', WB2, null, false]);
    const realId = foreign.assignment_id as string;
    const absentId = randomUUID();
    // A non-super actor sees neither the real foreign row nor a different error
    // shape for a row that does not exist at all.
    for (const probe of [realId, absentId]) {
      const seen = await rig.asUser(OO, (c: any) =>
        c.query(`SELECT count(*)::int n FROM public.profile_delegated_scope_assignments WHERE id=$1`,
          [probe]).then((r: any) => r.rows[0].n));
      expect(seen).toBe(0);
    }
    // The listing RPC refuses a foreign profile for a non-super caller instead
    // of answering with its contents.
    const foreignList = await rig.asUser(OO, (c: any) =>
      c.query(`SELECT count(*)::int n FROM public.phoenix_list_delegated_scopes($1,true)`, [WO])
        .then((r: any) => r.rows[0].n));
    expect(foreignList).toBe(0);
    // Revoking a real-but-foreign assignment and a nonexistent one are both
    // denied identically for a non-super actor.
    const errors = await Promise.all([realId, absentId].map(id =>
      rejects(() => rpc(OO, 'phoenix_admin_revoke_delegated_scope', [id, null, 'probe']))));
    expect(errors[0]).toEqual(errors[1]);
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope', [realId, null, 'oracle probe complete']);
  });

  // 187 changes exactly ONE thing in phoenix_recall_outlet_inbound_movement:
  // which selector the CROSS-organization branch authorizes on. Everything
  // after that branch is 185's untouched body, already proven end-to-end by
  // 185-f3-outlet-recall. So the authorization matrix is asserted exactly, and
  // the real RPC is driven for the fail-closed/non-oracle contract.
  it('authorizes outlet recall on the exact point cross-org and keeps same-org on the warehouse', async () => {
    const RECALL = 'outlet_stock.recall';
    await rpc(SUPER, 'assign_profile_permissions', [WO2, { [RECALL]: true }]);

    // Same-org parity FIRST: an org-A actor recalling an org-A outlet is still
    // authorized through the OWNING WAREHOUSE selector, exactly as in 185.
    expect(await allowed(WO, RECALL, A, WA, null)).toBe(true);

    // (a) delegated warehouse WITHOUT child inheritance must not reach outlets.
    const noChildren = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope',
      [WO2, B, 'warehouse', WB, null, false]);
    expect(await allowed(WO2, RECALL, B, null, PB)).toBe(false);
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [noChildren.assignment_id, null, 'recall matrix step a']);

    // (b) an EXACT point delegation authorizes that point and nothing else.
    const point = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope',
      [WO2, B, 'distribution_point', null, PB, false]);
    expect(await allowed(WO2, RECALL, B, null, PB)).toBe(true);
    expect(await allowed(WO2, RECALL, B, null, PB2)).toBe(false);
    expect(await allowed(WO2, RECALL, B, WB, null)).toBe(false);
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [point.assignment_id, null, 'recall matrix step b']);

    // (c) warehouse + child inheritance authorizes structural children only.
    const children = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope',
      [WO2, B, 'warehouse', WB, null, true]);
    expect(await allowed(WO2, RECALL, B, null, PB)).toBe(true);
    expect(await allowed(WO2, RECALL, B, null, PB2)).toBe(true);
    expect(await allowed(WO2, RECALL, B, null, PA)).toBe(false);

    // (d) the selector is fail-closed and gives away nothing: a fabricated
    // movement id and a well-formed but non-recallable one are indistinguishable.
    const errors = await Promise.all([randomUUID(), randomUUID()].map(id =>
      rejects(() => rpc(WO2, 'phoenix_recall_outlet_inbound_movement', [id, 'M187-RECALL-1', null]))));
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]).toContain('forbidden_outlet_recall');

    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [children.assignment_id, null, 'recall matrix complete']);
    expect(await allowed(WO2, RECALL, B, null, PB)).toBe(false);
  });

  // A delegated recipient MUST have a primary-organization anchor. Delegation is
  // defined relative to it — the direct grant refuses it and the snapshot
  // excludes it — so a NULL anchor has nothing to refuse and nothing to exclude
  // and must fail closed rather than be read as "no organization to exclude".
  it('refuses every grant path for a recipient with no primary organization', async () => {
    const delta = async () => (await admin(
      `SELECT (SELECT count(*)::int FROM profile_delegated_scope_assignments WHERE profile_id=$1) rows,
              (SELECT count(DISTINCT grant_group_id)::int FROM profile_delegated_scope_assignments WHERE profile_id=$1) groups,
              (SELECT count(*)::int FROM audit_logs WHERE payload->>'profile_id'=$1::text) audits`,
      [NOORG])).rows[0];

    const before = await delta();
    expect(before).toEqual({ rows: 0, groups: 0, audits: 0 });

    // A. network snapshot — the path that would otherwise grant the WHOLE network.
    expect(await rejects(() => rpc(SUPER, 'phoenix_admin_grant_delegated_network_snapshot', [NOORG])))
      .toContain('delegated_scope_recipient_ineligible');
    // B/C/D. every direct grant shape.
    for (const args of [
      [NOORG, B, 'organization', null, null, false],
      [NOORG, B, 'warehouse', WB, null, false],
      [NOORG, B, 'distribution_point', null, PB, false],
    ] as const) {
      expect(await rejects(() => rpc(SUPER, 'phoenix_admin_grant_delegated_scope', [...args])))
        .toContain('delegated_scope_recipient_ineligible');
    }
    // Zero assignment, grant-group and audit delta across all four refusals.
    expect(await delta()).toEqual(before);
    expect(await allowed(NOORG, 'warehouse_stock.view', B, WB, null)).toBe(false);
  });

  // E + F. The SECURITY DEFINER catalog re-derives the anchor itself, so even a
  // corrupt/legacy row that bypassed the grant RPCs projects nothing.
  it('projects an empty catalog for an unanchored caller even with corrupt delegated rows', async () => {
    const asNoOrg = () => rig.asUser(NOORG, (c: any) =>
      c.query(`SELECT organization_id, warehouse_id, distribution_point_id
                 FROM public.phoenix_my_operational_resource_catalog()`)
        .then((r: any) => r.rows));
    expect(await asNoOrg()).toEqual([]);

    // Admin-inserted rows that the grant RPCs would never have created. This is
    // the corrupt-legacy scenario, constructed ONLY on the disposable rig.
    await admin(`
      INSERT INTO profile_delegated_scope_assignments
        (profile_id,target_organization_id,scope_type,include_child_outlets,grant_group_id,grant_origin)
      VALUES ($1,$2,'organization',false,gen_random_uuid(),'direct'),
             ($1,$2,'warehouse',true,gen_random_uuid(),'direct')`,
      [NOORG, B]).catch(async () => {
        // The warehouse row needs its warehouse_id; insert the shapes separately
        // if the composite constraint rejects the batch above.
        await admin(`INSERT INTO profile_delegated_scope_assignments
          (profile_id,target_organization_id,scope_type,include_child_outlets,grant_group_id,grant_origin)
          VALUES ($1,$2,'organization',false,gen_random_uuid(),'direct')`, [NOORG, B]);
        await admin(`INSERT INTO profile_delegated_scope_assignments
          (profile_id,target_organization_id,scope_type,warehouse_id,include_child_outlets,grant_group_id,grant_origin)
          VALUES ($1,$2,'warehouse',$3,true,gen_random_uuid(),'direct')`, [NOORG, B, WB]);
      });
    const planted = await admin(
      `SELECT count(*)::int n FROM profile_delegated_scope_assignments WHERE profile_id=$1 AND is_active`,
      [NOORG]);
    expect(planted.rows[0].n).toBeGreaterThan(0);

    // Defence in depth: rows exist, yet nothing is projected and nothing is
    // authorized, because the anchor is re-derived rather than trusted.
    expect(await asNoOrg()).toEqual([]);
    expect(await allowed(NOORG, 'warehouse_stock.view', B, WB, null)).toBe(false);
    expect(await allowed(NOORG, 'warehouse_stock.view', B, null, null)).toBe(false);
    expect(await allowed(NOORG, 'outlet_stock.view', B, null, PB)).toBe(false);
    expect(await admin(`SELECT public._phoenix_delegated_recipient_is_eligible_v1($1) e`, [NOORG])
      .then((r: any) => r.rows[0].e)).toBe(false);

    // G. A properly anchored recipient is unaffected by any of this.
    expect(await admin(`SELECT public._phoenix_delegated_recipient_is_eligible_v1($1) e`, [WO2])
      .then((r: any) => r.rows[0].e)).toBe(true);
    const ok = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope',
      [WO2, B, 'warehouse', WB, null, false]);
    expect(ok.ok).toBe(true);
    expect(await allowed(WO2, 'warehouse_stock.view', B, WB, null)).toBe(true);
    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [ok.assignment_id, null, 'anchor parity check complete']);

    // H. Same-org PRIMARY authorization is untouched by the anchor rule.
    expect(await allowed(WO, 'warehouse_stock.view', A, WA, null)).toBe(true);
    expect(await allowed(IA, 'warehouse_stock.view', A, WA, null)).toBe(true);
  });

  // Inheritance must not outlive the topology it was scoped to. Migration 183
  // deliberately permits deactivating a NON-health-sector warehouse whose only
  // children are pharmacy outlets (a pharmacy is legal with no owning
  // warehouse at all), so "inactive parent + active child" is reachable in
  // production, not a synthetic state.
  it('child-outlet inheritance dies with the parent warehouse and returns only on reactivation', async () => {
    // A FRESH actor: OO2's profile is deleted by the lifecycle test above and
    // OO already holds an organization-wide scope on B that would satisfy the
    // ask on its own and mask a missing denial.
    const OO3 = '00000000-0000-0000-0000-000000187309';
    // WB is is_main, and warehouses_main_requires_active_chk forbids
    // deactivating a main warehouse, so this uses the NON-main sibling WB2 and
    // gives it a pharmacy child of its own.
    const PB3 = '00000000-0000-0000-0000-000000187204';
    await admin(`INSERT INTO auth.users(id,email) VALUES ($1,'m187-oo3@rig.local')
                   ON CONFLICT (id) DO NOTHING`, [OO3]);
    await admin(`UPDATE profiles SET role='outlet_officer',status='active',organization_id=$2
                  WHERE id=$1`, [OO3, A]);
    await admin(`INSERT INTO distribution_points
                   (id,organization_id,warehouse_id,name,name_ar,point_type,status)
                 VALUES ($1,$2,$3,'B sibling depot outlet','منفذ ب ٣','pharmacy','active')
                 ON CONFLICT (id) DO NOTHING`, [PB3, B, WB2]);
    await rpc(SUPER, 'assign_profile_permissions', [OO3, { 'outlet_stock.view': true }]);

    const grant = await rpc(SUPER, 'phoenix_admin_grant_delegated_scope',
      [OO3, B, 'warehouse', WB2, null, true]);
    expect(grant.ok).toBe(true);
    const projected = () => rig.asUser(OO3, (c: any) =>
      c.query(`SELECT count(*)::int n FROM public.phoenix_my_operational_resource_catalog()
                 WHERE distribution_point_id=$1`, [PB3])
        .then((r: any) => r.rows[0].n));

    expect(await allowed(OO3, 'outlet_stock.view', B, null, PB3)).toBe(true);
    expect(await projected()).toBeGreaterThan(0);

    await admin(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [WB2]);
    expect(await admin(`SELECT status FROM warehouses WHERE id=$1`, [WB2])
      .then((r: any) => r.rows[0].status)).toBe('inactive');
    // 183 permits this: outside the health sector an active pharmacy outlet
    // never blocks its warehouse's deactivation, so the child survives.
    expect(await admin(`SELECT status FROM distribution_points WHERE id=$1`, [PB3])
      .then((r: any) => r.rows[0].status)).toBe('active');

    // The DIRECT ask about this warehouse was always refused once inactive;
    // the INHERITED ask about its child must agree rather than contradict it,
    // and the catalog must stop projecting it too.
    expect(await allowed(OO3, 'outlet_stock.view', B, WB2, null)).toBe(false);
    expect(await allowed(OO3, 'outlet_stock.view', B, null, PB3)).toBe(false);
    expect(await projected()).toBe(0);

    // The grant itself was never revoked, so reactivating restores it.
    await admin(`UPDATE warehouses SET status='active' WHERE id=$1`, [WB2]);
    expect(await allowed(OO3, 'outlet_stock.view', B, null, PB3)).toBe(true);
    expect(await projected()).toBeGreaterThan(0);

    await rpc(SUPER, 'phoenix_admin_revoke_delegated_scope',
      [grant.assignment_id, null, 'parent liveness matrix complete']);
    expect(await allowed(OO3, 'outlet_stock.view', B, null, PB3)).toBe(false);
  });

  // The catalog re-derives the FOREIGN-organization property, not just the
  // anchor. A hand-written same-org row is inert at the authorization helper
  // (which takes the primary branch) but would otherwise make the catalog fan
  // out over the caller's ENTIRE own organization — breadth the primary
  // branches deliberately withhold from an operational role.
  it('ignores a corrupt same-organization delegated row instead of projecting the whole home org', async () => {
    const homeDelegated = () => rig.asUser(WO2, (c: any) =>
      c.query(`SELECT count(*)::int n FROM public.phoenix_my_operational_resource_catalog()
                 WHERE organization_id=$1 AND scope_source='delegated'`, [A])
        .then((r: any) => r.rows[0].n));
    expect(await homeDelegated()).toBe(0);

    // No grant path can create this row — only direct table access can.
    expect(await rejects(() => rpc(SUPER, 'phoenix_admin_grant_delegated_scope',
      [WO2, A, 'organization', null, null, false])))
      .toContain('primary_scope_must_use_primary_model');
    await admin(`INSERT INTO profile_delegated_scope_assignments
      (profile_id,target_organization_id,scope_type,include_child_outlets,grant_group_id,grant_origin)
      VALUES ($1,$2,'organization',false,gen_random_uuid(),'direct')`, [WO2, A]);
    expect(await admin(`SELECT count(*)::int n FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND target_organization_id=$2 AND is_active`, [WO2, A])
      .then((r: any) => r.rows[0].n)).toBe(1);

    // The row is active, yet projects nothing and authorizes nothing.
    expect(await homeDelegated()).toBe(0);
    expect(await allowed(WO2, 'outlet_stock.view', A, null, PA)).toBe(false);
    expect(await allowed(WO2, 'warehouse_stock.view', A, WA, null)).toBe(false);
    await admin(`DELETE FROM profile_delegated_scope_assignments
      WHERE profile_id=$1 AND target_organization_id=$2`, [WO2, A]);
  });

  // The four policies this migration ADDS are not the whole cross-organization
  // read surface: the forward-replaced helper is the primitive behind many
  // pre-existing policies that carry no organization predicate of their own.
  // Pin the real set so a future migration cannot widen it unnoticed.
  it('pins the exact set of tables the forward replacement makes cross-organization', async () => {
    const WIDENED = [
      'outlet_return_request_lines', 'outlet_return_requests',
      'outlet_return_shipment_lines', 'outlet_return_shipments',
      'outlet_stock', 'outlet_stock_movements',
      'warehouse_dispatch_lines', 'warehouse_dispatches',
      'warehouse_quarantine_stock', 'warehouse_quarantine_stock_movements',
      'warehouse_return_request_lines', 'warehouse_return_requests',
      'warehouse_return_shipment_lines', 'warehouse_return_shipments',
      'warehouse_stock', 'warehouse_stock_movements',
      'warehouse_transfer_lines', 'warehouse_transfer_request_lines',
      'warehouse_transfer_requests', 'warehouse_transfers',
    ];
    const census = await admin(`
      WITH helper AS (
        -- EVERY function whose body reaches the primitive, not just the
        -- phoenix_can_read_* family: procurement_suppliers is gated through
        -- phoenix_procurement_org_authority, and a can_read-only filter would
        -- not see it — nor any future wrapper a later migration introduces.
        SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
          AND p.prosrc LIKE '%phoenix_profile_has_scoped_permission%'
          AND p.proname <> 'phoenix_profile_has_scoped_permission'
      ), pol AS (
        SELECT tablename, coalesce(qual,'')||' '||coalesce(with_check,'') AS body
        FROM pg_policies WHERE schemaname='public'
      ), expanded AS (
        SELECT p.tablename,
               p.body||' '||coalesce((SELECT string_agg(h.prosrc,' ') FROM helper h
                                       WHERE p.body LIKE '%'||h.proname||'%'),'') AS full_text
        FROM pol p
        WHERE p.body LIKE '%phoenix_profile_has_scoped_permission%'
           OR EXISTS (SELECT 1 FROM helper h WHERE p.body LIKE '%'||h.proname||'%')
      )
      SELECT DISTINCT e.tablename, (EXISTS (
               SELECT 1 FROM public.delegated_operational_permission_keys k
               WHERE e.full_text LIKE '%'''||k.permission_key||'''%')) AS widened
      FROM expanded e`);
    const widened = census.rows.filter((r: any) => r.widened).map((r: any) => r.tablename);
    expect(widened.sort()).toEqual([...WIDENED].sort());

    // Pin the reassuring half too, and pin its SIZE — an enumeration that is
    // only checked for its members can silently lose one. procurement_suppliers
    // is the trap: it reaches the primitive through
    // phoenix_procurement_org_authority, so a census that followed only the
    // phoenix_can_read_* family would never see it at all.
    const notWidened = census.rows.filter((r: any) => !r.widened).map((r: any) => r.tablename);
    expect(notWidened.sort()).toEqual([
      'inventory_alerts', 'inventory_signal_thresholds',
      'inventory_transfer_suggestions', 'phoenix_report_snapshots',
      'procurement_order_events', 'procurement_order_lines', 'procurement_orders',
      'procurement_receipt_lines', 'procurement_receipts', 'procurement_returns',
      'procurement_suppliers',
    ].sort());
    expect(census.rows).toHaveLength(WIDENED.length + notWidened.length);

    // The tables that stay same-org do so because their gating keys are
    // deliberately ABSENT from the allowlist — assert the cause, not just the
    // effect, so adding one of these keys later fails here.
    for (const key of ['reports.view', 'inventory.view_signals', 'local_procurement.view']) {
      expect(await admin(
        `SELECT count(*)::int n FROM public.delegated_operational_permission_keys WHERE permission_key=$1`,
        [key]).then((r: any) => r.rows[0].n), key).toBe(0);
    }
  });
});
