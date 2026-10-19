/**
 * R1-b candidate 02 (NOT APPLIED in any real environment) — rehearsal on the disposable rig: the registration writers become
 * callable through `authenticated`, but ONLY for an organization carrying its own activation marker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { ORG, ORG_OTHER, U, read, refusal, helpers, buildWithCandidates, grantManualKey, type Rig } from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql',
  'R1a_04_manual_routines_inert.sql', 'R1a_05_blockers_digest_d27.sql', 'R1a_06_material_registration_inert.sql'];
const P = 'public.phoenix_central_needs_';
const NOT_ACTIVATED = 'manual_intake_not_activated';

run('R1-b candidate 02 — material-registration activation rehearsal (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig;
  const h = helpers(() => rig);
  const { admin, txAs, as } = h;
  let n = 0;
  const create = (sub: string, org = ORG, key = randomUUID(), role = 'authenticated') =>
    as(sub, `SELECT ${P}create_material_request_draft($1,$2,NULL,NULL,'10 mg','Tablet','box',NULL,NULL,'manual_typed','{}'::jsonb,NULL,$3) r`, [org, `Activation probe ${++n} ${randomUUID().slice(0, 5)}`, key], role).then((r: any[]) => r[0].r);

  beforeAll(async () => {
    rig = await buildWithCandidates(F, 1);
    await grantManualKey(rig, [U.maker, U.saKeys]);
    await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) SELECT x, 'central_needs.material_review', true FROM unnest($1::uuid[]) x
                 ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [[U.saKeys, U.saOther]]);
    await admin(`UPDATE organizations SET organization_kind='pharmacy_department_authority', institution_class=NULL WHERE id=$1`, [ORG_OTHER]).catch(() => undefined);
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  it('before R1b_02 the writers are not callable through authenticated (A2 candidate 06 is inert)', async () => {
    expect((await refusal(create(U.maker))).code).toBe('42501');
    await admin(read('R1b_01_manual_activation_NOT_APPLIED.sql'));
    await admin(read('R1b_02_material_registration_activation_NOT_APPLIED.sql'));
  });

  it('an authorized requester in an organization with NO marker is refused and nothing is written', async () => {
    const before = (await admin(`SELECT (SELECT count(*) FROM central_needs_material_requests)::int r, (SELECT count(*) FROM central_needs_material_request_events)::int e, (SELECT count(*) FROM central_items)::int i`))[0];
    const e = await refusal(create(U.maker));
    expect(e.message).toBe(NOT_ACTIVATED);
    expect((await admin(`SELECT (SELECT count(*) FROM central_needs_material_requests)::int r, (SELECT count(*) FROM central_needs_material_request_events)::int e, (SELECT count(*) FROM central_items)::int i`))[0]).toEqual(before);
  });

  it('a fixture request of an unactivated organization cannot change status or be linked (guards on status and links)', async () => {
    let id = '';
    await txAs(null, async (q) => {
      id = (await q(`INSERT INTO central_needs_material_requests (organization_id, requester_id, requester_role, scientific_name, unit, identity_key, provenance_kind, idempotency_key)
        VALUES ($1,$2,'central_warehouse_manager','Fixture','box','nm:fixture|||box','manual_typed',$3) RETURNING id`, [ORG, U.maker, randomUUID()]))[0].id;
    }, { replica: true });
    const e = await refusal(txAs(null, async (q) => { await q(`UPDATE central_needs_material_requests SET status='cancelled', decided_at=now(), version=version+1 WHERE id=$1`, [id]); }, { replica: false }));
    expect(e.message).toBe(NOT_ACTIVATED);
    expect((await admin(`SELECT status FROM central_needs_material_requests WHERE id=$1`, [id]))[0].status).toBe('draft');
  });

  it('a marker of ANOTHER organization does not open this one; that organization\'s own legitimate actor passes the guard', async () => {
    await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG_OTHER]);
    expect((await refusal(create(U.maker))).message).toBe(NOT_ACTIVATED);
    const own = await create(U.other, ORG_OTHER).catch((e: Error) => ({ error: e.message }));
    expect(JSON.stringify(own)).not.toContain(NOT_ACTIVATED);
  });

  it('after ORG\'s OWN marker the journey runs through the real authenticated role: draft -> submit -> review -> approve new -> link', async () => {
    await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG]);
    const d = await create(U.maker);
    expect(d).toMatchObject({ ok: true, status: 'draft' });
    const s = (await as(U.maker, `SELECT ${P}submit_material_request($1,$2) r`, [d.request_id, d.version]))[0].r;
    const rv = (await as(U.saKeys, `SELECT ${P}start_material_review($1,$2) r`, [d.request_id, s.version]))[0].r;
    const a = (await as(U.saKeys, `SELECT ${P}approve_new_material($1,$2,ARRAY[]::uuid[],'registered') r`, [d.request_id, rv.version]))[0].r;
    expect(a).toMatchObject({ status: 'approved_new' });
    let rev = '';
    await txAs(null, async (q) => {
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2090) RETURNING id`, [ORG]);
      rev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by) VALUES ($1,$2,1,'draft','manual',$3) RETURNING id`, [plan, ORG, U.maker]))[0].id;
    }, { replica: true });
    const l = (await as(U.maker, `SELECT ${P}link_material_request_to_draft($1,$2) r`, [d.request_id, rev]))[0].r;
    expect(l).toMatchObject({ ok: true, central_item_id: a.central_item_id });
    expect((await as(U.viewer, `SELECT count(*)::int n FROM ${P}list_material_request_events($1)`, [d.request_id]))[0].n).toBe(5);
  });

  it('even in an activated organization the key / reviewer rules hold; anon and service_role never may call', async () => {
    expect((await refusal(create(U.viewer))).message).toMatch(/forbidden_central_needs/);
    const d = await create(U.maker);
    const s = (await as(U.maker, `SELECT ${P}submit_material_request($1,$2) r`, [d.request_id, d.version]))[0].r;
    expect((await refusal(as(U.checker, `SELECT ${P}start_material_review($1,$2)`, [d.request_id, s.version]))).message).toMatch(/forbidden_central_needs/);
    expect((await refusal(as(U.maker, `SELECT ${P}start_material_review($1,$2)`, [d.request_id, s.version]))).message).toMatch(/forbidden_central_needs/);
    for (const role of ['anon', 'service_role']) expect((await refusal(create(U.maker, ORG, randomUUID(), role))).code, role).toBe('42501');
    expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
  });
});
