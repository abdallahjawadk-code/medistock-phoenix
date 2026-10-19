/**
 * R1 acceptance (database layer) — the CANONICAL lifecycle routines (readiness, submit, approve, reject, supersede) over a MANUAL revision,
 * driven through the real `authenticated` role on the disposable rig with candidates R1a_01..06 + R1b_01 + R1b_02 applied and the organization
 * activated. Earlier suites proved each candidate piece; this proves the chain a person actually walks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { ORG, ORG_BENE, ORG_BENE_B, U, read, refusal, helpers, buildWithCandidates, newItem, grantManualKey, type Rig } from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql',
  'R1a_04_manual_routines_inert.sql', 'R1a_05_blockers_digest_d27.sql', 'R1a_06_material_registration_inert.sql'];
const P = 'public.phoenix_central_needs_';

run('R1 acceptance — canonical lifecycle over a manual revision (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig; let item = ''; let item2 = '';
  const h = helpers(() => rig);
  const { admin, as } = h;
  let year = 2030;
  const one = async (user: string, sql: string, args: unknown[] = []) => (await as(user, sql, args))[0];
  const rpc = async (user: string, fn: string, args: unknown[]) =>
    (await one(user, `SELECT ${P}${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args)).r;
  const open = async () => { year += 1; const r = await rpc(U.maker, 'open_manual_plan_revision', [ORG, year]); return { rev: r.plan_revision_id as string, year }; };
  const addLine = (rev: string, qty: string, ben = ORG_BENE, it = item) =>
    rpc(U.maker, 'add_manual_need_line', [rev, ben, it, null, qty, 'planned need', randomUUID(), null, null]);
  const status = async (rev: string) => (await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [rev]))[0].status as string;

  beforeAll(async () => {
    rig = await buildWithCandidates(F, 1);
    await admin(read('R1b_01_manual_activation_NOT_APPLIED.sql'));
    await admin(read('R1b_02_material_registration_activation_NOT_APPLIED.sql'));
    item = await newItem(admin); item2 = await newItem(admin);
    await grantManualKey(rig, [U.maker, U.maker2, U.saKeys]);
    await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG]);
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  it('open -> add line -> readiness (empty is blocked, with a line ready) -> submit -> the maker CANNOT approve -> an independent approver approves', async () => {
    const { rev } = await open();
    const empty = await rpc(U.maker, 'review_readiness', [rev]);
    expect(empty.ready).toBe(false);
    expect(JSON.stringify(empty.blockers)).toContain('manual_revision_has_no_lines');
    await addLine(rev, '12.5');
    const ready = await rpc(U.maker, 'review_readiness', [rev]);
    expect(ready).toMatchObject({ ready: true });
    await rpc(U.maker, 'submit_revision', [rev]);
    expect(await status(rev)).toBe('submitted');
    // the maker holds no approve key by default; give one and prove SoD still refuses
    await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.approve',true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U.maker]);
    try {
      const e = await refusal(rpc(U.maker, 'approve_revision', [rev]));
      expect(e.message).toMatch(/separation_of_duties|forbidden_central_needs/);
      expect(await status(rev)).toBe('submitted');
    } finally {
      await admin(`UPDATE profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.approve'`, [U.maker]);
    }
    await rpc(U.checker, 'approve_revision', [rev]);
    expect(await status(rev)).toBe('approved');
    const [row] = await admin(`SELECT approved_by FROM central_needs_plan_revisions WHERE id=$1`, [rev]);
    expect(row.approved_by).toBe(U.checker);
    // the approved revision is frozen for line writers
    expect((await refusal(addLine(rev, '3', ORG_BENE_B, item2))).message).toMatch(/plan_revision_not_editable/);
  });

  it('rejection needs a reason and leaves a closed revision; a correction can then be opened', async () => {
    const { rev, year: y } = await open();
    await addLine(rev, '4');
    await rpc(U.maker, 'submit_revision', [rev]);
    const e = await refusal(rpc(U.checker, 'reject_revision', [rev, '  ']));
    expect(e.message).toBeTruthy();
    expect(await status(rev)).toBe('submitted');
    await rpc(U.checker, 'reject_revision', [rev, 'quantities need a recount']);
    expect(await status(rev)).toBe('rejected');
    const c = await rpc(U.maker, 'open_manual_correction_revision', [ORG, y, rev, 'recount done']);
    expect(c).toMatchObject({ revision_number: 2, status: 'draft', source_mode: 'manual' });
  });

  it('correction of an APPROVED revision: carry forward, correct a line, submit, independent approval SUPERSEDES the predecessor (one effective revision)', async () => {
    const { rev, year: y } = await open();
    const a = await addLine(rev, '10');
    await addLine(rev, '7', ORG_BENE_B, item2);
    await rpc(U.maker, 'submit_revision', [rev]);
    await rpc(U.checker, 'approve_revision', [rev]);
    const c = await rpc(U.maker, 'open_manual_correction_revision', [ORG, y, rev, 'annual update']);
    const carried = await rpc(U.maker, 'carry_forward_manual_lines', [c.plan_revision_id, rev]);
    expect(carried.carried_count).toBe(2);
    const [{ last }] = await admin(`SELECT id AS last FROM central_needs_manual_need_events WHERE plan_revision_id=$1 AND beneficiary_organization_id=$2 ORDER BY event_seq DESC LIMIT 1`, [c.plan_revision_id, ORG_BENE]);
    await rpc(U.maker, 'correct_manual_need_line', [c.plan_revision_id, ORG_BENE, item, null, '11', 'recount', randomUUID(), last, null]);
    expect((await rpc(U.maker, 'review_readiness', [c.plan_revision_id])).ready).toBe(true);
    await rpc(U.maker, 'submit_revision', [c.plan_revision_id]);
    await rpc(U.checker2, 'approve_revision', [c.plan_revision_id]);
    expect(await status(c.plan_revision_id)).toBe('approved');
    expect(await status(rev)).toBe('superseded');
    expect((await admin(`SELECT count(*)::int n FROM central_needs_plan_revisions r WHERE r.plan_id=(SELECT plan_id FROM central_needs_plan_revisions WHERE id=$1) AND r.status='approved'`, [rev]))[0].n).toBe(1);
    void a;
  });

  it('history: the revision lifecycle reader reports the manual open / submit / approve events to a view holder', async () => {
    const { rev, year: y } = await open();
    await addLine(rev, '2');
    await rpc(U.maker, 'submit_revision', [rev]);
    await rpc(U.checker, 'approve_revision', [rev]);
    const hist = await rpc(U.viewer, 'revision_lifecycle', [ORG, y]);
    const actions = JSON.stringify(hist);
    for (const a of ['open', 'submit', 'approve']) expect(actions, a).toContain(a);
  });

  it('an unauthorized actor cannot walk any step: no edit key, other organization, non-eligible role', async () => {
    const { rev, year: y } = await open();
    await addLine(rev, '1');
    for (const user of [U.viewer, U.other, U.inst]) {
      expect((await refusal(rpc(user, 'submit_revision', [rev]))).message, user).toMatch(/forbidden_central_needs|not_found|forbidden/);
      expect((await refusal(rpc(user, 'open_manual_plan_revision', [ORG, y + 50]))).message, user).toMatch(/forbidden_central_needs/);
    }
    expect(await status(rev)).toBe('draft');
  });
});
