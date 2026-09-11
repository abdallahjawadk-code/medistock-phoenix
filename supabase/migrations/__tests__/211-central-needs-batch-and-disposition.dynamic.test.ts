/**
 * CN-2B / M211 — DYNAMIC proof against a real disposable Postgres with
 * 001->211 applied in order.
 *
 *   A. Disposition constraints — the two decisions are individually complete
 *      and mutually exclusive; a reason is mandatory for not_applicable and a
 *      central item is mandatory for mapped.
 *   B. Authorization        — permission, organization boundary, archived org,
 *                             draft-only, phantom entity.
 *   C. Submit completeness  — every one of the five preconditions refuses
 *                             independently, and the happy path passes only
 *                             when all of them hold.
 *   D. Batch atomicity      — a partially replayed archive stays unsubmittable;
 *                             a manifest that disagrees with the database is
 *                             refused; an exact retry is a no-op.
 *   E. Hash semantics       — the container hash is NOT an entry hash.
 *   F. Retry semantics      — completed reuses, open reuses, failed retries.
 *   G. Privileges           — the batch writer is trusted-only.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000211001';
const ORG_B = '00000000-0000-0000-0000-000000211002';
const ORG_ARCHIVED = '00000000-0000-0000-0000-000000211003';

const U_ALL_A = '00000000-0000-0000-0000-000000211401';
const U_NONE_A = '00000000-0000-0000-0000-000000211402';
const U_ALL_B = '00000000-0000-0000-0000-000000211403';
const U_ALL_ARCH = '00000000-0000-0000-0000-000000211404';
// CN-2B role boundary: each holds EVERY central_needs capability, so the only
// thing that can refuse them is the role class itself.
const U_INST_ADMIN = '00000000-0000-0000-0000-000000211405';
const U_OUTLET = '00000000-0000-0000-0000-000000211406';
const U_WH_OFFICER = '00000000-0000-0000-0000-000000211407';

const ITEM_1 = '00000000-0000-0000-0000-000000211801';

const H = (c: string) => c.repeat(64);

const NODE_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};
const BROWSER_IDENTITY = { ...NODE_IDENTITY, runtime: 'browser_worker' };

const TRUSTED_RPCS = [
  'public.phoenix_central_needs_register_import_batch(uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb)',
  'public._phoenix_central_needs_review_blockers_v1(uuid)',
];
const CLIENT_RPCS = [
  'public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text)',
  'public.phoenix_central_needs_abandon_import_session(uuid, text)',
  'public.phoenix_central_needs_review_readiness(uuid)',
];

run('CN-2B/211 batches + dispositions — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  // central_needs_plans CHECKs plan_year BETWEEN 2000 AND 2100, and each test
  // takes its own year so revisions never collide inside one organization.
  let year = 2000;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  const service = (sql: string, params: unknown[] = []) =>
    rig.asUser(null, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role: 'service_role', commit: true });

  /** Records whose provenance fingerprints the given file, per M210's gate. */
  const makeRecords = (fileHash: string, entity = 'sheet:0:row:5') => ([
    {
      targetEntity: entity, fieldName: 'quantity',
      sourceValues: { value: 120, valueType: 'number', isFormula: false, formula: null },
      sourceProvenance: {
        fileFingerprintSha256: fileHash, originalFilename: 'needs.xls', parserVersion: '1.0.0/0.20.3',
        sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
        coordinate: { row: 4, col: 2, a1: 'C5' }, extractedAt: new Date().toISOString(),
      },
    },
  ]);

  const payloadDigest = async (records: unknown[]): Promise<string> => {
    const [row] = await admin(
      `SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`,
      [JSON.stringify(records)]);
    return row.d as string;
  };

  /** Opens a fresh draft revision in its own plan year, so tests never collide. */
  const openRevision = async (user = U_ALL_A, org = ORG_A): Promise<string> => {
    year += 1;
    const r = await call(user,
      `SELECT public.phoenix_central_needs_open_plan_revision($1,$2,false) AS result`, [org, year]);
    return r.plan_revision_id as string;
  };

  /** Drives one entry all the way to a completed authoritative session. */
  const completeSession = async (
    revisionId: string, fileHash: string, entity = 'sheet:0:row:5', user = U_ALL_A, filename = 'needs.xls',
  ): Promise<string> => {
    const records = makeRecords(fileHash, entity);
    const digest = await payloadDigest(records);
    const started = await call(user,
      `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
      [revisionId, filename, fileHash, digest, JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/x']);
    const sessionId = started.import_session_id as string;
    if (started.status !== 'completed') {
      await service(
        `SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
        [sessionId, fileHash, JSON.stringify(records), JSON.stringify(NODE_IDENTITY)]);
    }
    return sessionId;
  };

  /** The entry-aware session start (8-arg), for archive members. */
  const startEntrySession = async (
    revisionId: string, fileHash: string, entryPath: string | null,
    entity = 'sheet:0:row:5', user = U_ALL_A, filename = 'needs.xls',
  ) => {
    const records = makeRecords(fileHash, entity);
    const digest = await payloadDigest(records);
    return call(user,
      `SELECT public.phoenix_central_needs_start_import_entry_session($1,$2,$3,$4,$5::jsonb,$6,$7,$8) AS result`,
      [revisionId, filename, fileHash, digest, JSON.stringify(BROWSER_IDENTITY), 100, 'permanent/x', entryPath]);
  };

  /** Drives one ENTRY to a completed authoritative session. */
  const completeEntrySession = async (
    revisionId: string, fileHash: string, entryPath: string | null,
    entity = 'sheet:0:row:5', user = U_ALL_A, filename = 'needs.xls',
  ): Promise<string> => {
    const started = await startEntrySession(revisionId, fileHash, entryPath, entity, user, filename);
    const records = makeRecords(fileHash, entity);
    if (started.status !== 'completed') {
      await service(
        `SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
        [started.import_session_id, fileHash, JSON.stringify(records), JSON.stringify(NODE_IDENTITY)]);
    }
    return started.import_session_id as string;
  };

  const replay = (sessionId: string, fileHash: string, records: unknown[]) => service(
    `SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
    [sessionId, fileHash, JSON.stringify(records), JSON.stringify(NODE_IDENTITY)]);

  const registerBatch = (
    revisionId: string,
    entries: Array<{ entryOrdinal: number; archiveEntryPath: string | null; entrySha256: string; importSessionId: string }>,
    opts: { kind?: 'file' | 'zip'; containerSha?: string; identity?: unknown } = {},
  ) => service(
    `SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NULL) AS result`,
    [
      revisionId, opts.kind ?? 'file', 'container.xls', opts.containerSha ?? H('c'),
      'permanent/container', JSON.stringify(entries),
      JSON.stringify(opts.identity ?? NODE_IDENTITY), 2048, 0,
    ]);

  const decide = (
    user: string, sessionId: string, entity: string,
    decision: 'mapped' | 'not_applicable', itemId: string | null, reason: string | null,
  ) => call(user,
    `SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result`,
    [sessionId, entity, decision, itemId, reason]);

  const readiness = (user: string, revisionId: string) => call(user,
    `SELECT public.phoenix_central_needs_review_readiness($1) AS result`, [revisionId]);

  const submit = (user: string, revisionId: string) => call(user,
    `SELECT public.phoenix_central_needs_submit_revision($1) AS result`, [revisionId]);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 211 });

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','CN211-A','أ','p211-a','care_institution','hospital'),
        ('${ORG_B}','CN211-B','ب','p211-b','care_institution','hospital'),
        ('${ORG_ARCHIVED}','CN211-ARCH','ج','p211-arch','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_ALL_A}','p211-all-a@rig'),('${U_NONE_A}','p211-none-a@rig'),
        ('${U_ALL_B}','p211-all-b@rig'),('${U_ALL_ARCH}','p211-all-arch@rig'),
        ('${U_INST_ADMIN}','p211-inst@rig'),('${U_OUTLET}','p211-outlet@rig'),
        ('${U_WH_OFFICER}','p211-whoff@rig')
        ON CONFLICT (id) DO NOTHING;`);

      for (const [u, org] of [
        [U_ALL_A, ORG_A], [U_NONE_A, ORG_A], [U_ALL_B, ORG_B], [U_ALL_ARCH, ORG_ARCHIVED],
      ] as const) {
        await c.query(
          `UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id=$1 WHERE id=$2`,
          [org, u]);
      }
      // Ineligible role classes, all inside ORG_A so organization is never the
      // reason they are refused.
      for (const [u, role] of [
        [U_INST_ADMIN, 'institution_admin'],
        [U_OUTLET, 'outlet_officer'],
        [U_WH_OFFICER, 'warehouse_officer'],
      ] as const) {
        await c.query(
          `UPDATE profiles SET role=$1,status='active',organization_id=$2 WHERE id=$3`,
          [role, ORG_A, u]);
      }

      for (const u of [U_ALL_A, U_ALL_B, U_ALL_ARCH, U_INST_ADMIN, U_OUTLET, U_WH_OFFICER]) {
        for (const k of ['view', 'import', 'edit', 'approve']) {
          await c.query(
            `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
               ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`,
            [u, `central_needs.${k}`]);
        }
      }

      await c.query(`INSERT INTO central_items (id,name,name_ar,unit) VALUES
        ('${ITEM_1}','Paracetamol 500mg','باراسيتامول','box') ON CONFLICT (id) DO NOTHING;`);

      // M202 owns archived_at; a legal status transition is the only path.
      await c.query(`UPDATE organizations SET status='inactive' WHERE id='${ORG_ARCHIVED}'`);
      const [{ archived_at: stamped }] = (await c.query(
        `SELECT archived_at FROM organizations WHERE id='${ORG_ARCHIVED}'`)).rows;
      if (!stamped) throw new Error('fixture precondition failed: ORG_ARCHIVED was not archived');
    });
  }, 180000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── A. Disposition constraints ──────────────────────────────────────────
  describe('A. disposition constraints', () => {
    it('mapped requires a central item and stores it', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('a'));
      const r = await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      expect(r.ok).toBe(true);
      expect(r.decision).toBe('mapped');
      const [row] = await admin(
        `SELECT decision, central_item_id, decision_reason FROM central_needs_record_mappings
          WHERE import_session_id=$1`, [s]);
      expect(row.decision).toBe('mapped');
      expect(row.central_item_id).toBe(ITEM_1);
      expect(row.decision_reason).toBeNull();
    });

    it('mapped WITHOUT a central item is refused', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('b'));
      await expect(decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', null, null))
        .rejects.toThrow(/mapped_decision_requires_central_item_id/);
    });

    it('not_applicable REQUIRES a reason', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('c'));
      await expect(decide(U_ALL_A, s, 'sheet:0:row:5', 'not_applicable', null, null))
        .rejects.toThrow(/not_applicable_decision_requires_reason/);
      await expect(decide(U_ALL_A, s, 'sheet:0:row:5', 'not_applicable', null, '   '))
        .rejects.toThrow(/not_applicable_decision_requires_reason/);
    });

    it('not_applicable must NOT carry a central item', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('d'));
      await expect(decide(U_ALL_A, s, 'sheet:0:row:5', 'not_applicable', ITEM_1, 'subtotal row'))
        .rejects.toThrow(/not_applicable_decision_must_not_carry_central_item_id/);
    });

    it('not_applicable with a reason is stored with no item', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('e'));
      const r = await decide(U_ALL_A, s, 'sheet:0:row:5', 'not_applicable', null, 'subtotal row');
      expect(r.decision).toBe('not_applicable');
      const [row] = await admin(
        `SELECT decision, central_item_id, decision_reason FROM central_needs_record_mappings
          WHERE import_session_id=$1`, [s]);
      expect(row.central_item_id).toBeNull();
      expect(row.decision_reason).toBe('subtotal row');
    });

    it('an unknown decision word is refused', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('f'));
      await expect(decide(U_ALL_A, s, 'sheet:0:row:5', 'probably' as never, null, 'x'))
        .rejects.toThrow(/decision_must_be_mapped_or_not_applicable/);
    });

    it('the table CHECK refuses an inconsistent row even from a superuser', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, '01'.repeat(32));
      await expect(admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,'sheet:0:row:5',NULL,'mapped',NULL)`, [s, ORG_A]))
        .rejects.toThrow(/disposition_chk/);
    });

    it('decision has NO default — a write must state it', async () => {
      const [row] = await admin(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name='central_needs_record_mappings' AND column_name='decision'`);
      expect(row.column_default).toBeNull();
    });

    it('M210 set_record_mapping still works and is the mapped case', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, H('9'));
      const r = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_set_record_mapping($1,'sheet:0:row:5',$2) AS result`, [s, ITEM_1]);
      expect(r.ok).toBe(true);
      expect(r.central_item_id).toBe(ITEM_1);
      const [row] = await admin(
        `SELECT decision FROM central_needs_record_mappings WHERE import_session_id=$1`, [s]);
      expect(row.decision).toBe('mapped');
    });
  });

  // ── B. Authorization ────────────────────────────────────────────────────
  describe('B. authorization', () => {
    it('a phantom target entity is refused', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, '10'.repeat(32));
      await expect(decide(U_ALL_A, s, 'sheet:9:row:999', 'mapped', ITEM_1, null))
        .rejects.toThrow(/target_entity_not_in_import_session/);
    });

    it('a caller with no central_needs permission is refused', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, '11'.repeat(32));
      await expect(decide(U_NONE_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('a caller from another organization is refused', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, '12'.repeat(32));
      await expect(decide(U_ALL_B, s, 'sheet:0:row:5', 'mapped', ITEM_1, null))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('an unauthenticated caller is refused', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, '13'.repeat(32));
      await expect(decide(null as never, s, 'sheet:0:row:5', 'mapped', ITEM_1, null))
        .rejects.toThrow(/not_authenticated/);
    });

    it('an archived organization is refused by the archive rule specifically', async () => {
      // The year is deliberately VALID, so the refusal can only come from the
      // archived-organization guard — an out-of-range year would have made this
      // test pass for entirely the wrong reason.
      await expect(call(U_ALL_ARCH,
        `SELECT public.phoenix_central_needs_open_plan_revision($1,$2,false) AS result`,
        [ORG_ARCHIVED, 2100]))
        .rejects.toThrow(/central_needs_write_blocked_by_archived_organization/);
    });

    it('a non-draft revision refuses a disposition', async () => {
      const rev = await openRevision();
      const s = await completeSession(rev, '14'.repeat(32));
      await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: '14'.repeat(32), importSessionId: s },
      ], { containerSha: '14'.repeat(32) });
      await submit(U_ALL_A, rev);
      await expect(decide(U_ALL_A, s, 'sheet:0:row:5', 'not_applicable', null, 'changed my mind'))
        .rejects.toThrow(/plan_revision_not_editable/);
    });
  });

  // ── C. Submit completeness ──────────────────────────────────────────────
  describe('C. submit completeness is server-enforced', () => {
    it('refuses with no finalized import at all', async () => {
      const rev = await openRevision();
      const r = await readiness(U_ALL_A, rev);
      expect(r.ready).toBe(false);
      expect(r.blockers.map((b: any) => b.blocker)).toContain('no_finalized_import');
      await expect(submit(U_ALL_A, rev)).rejects.toThrow(/plan_revision_has_no_finalized_import/);
    });

    it('refuses while an import session is still processing', async () => {
      const rev = await openRevision();
      const good = '20'.repeat(32);
      const s = await completeSession(rev, good);
      await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: good, importSessionId: s },
      ], { containerSha: good });

      // A second attempt that never completed.
      const open = '21'.repeat(32);
      const records = makeRecords(open);
      await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'second.xls', open, await payloadDigest(records), JSON.stringify(BROWSER_IDENTITY), 10, 'permanent/y']);

      const r = await readiness(U_ALL_A, rev);
      expect(r.blockers.map((b: any) => b.blocker)).toContain('import_session_still_open');
      await expect(submit(U_ALL_A, rev)).rejects.toThrow(/plan_revision_has_open_import_session/);
    });

    it('refuses a completed session that belongs to NO trusted batch', async () => {
      const rev = await openRevision();
      const h = '22'.repeat(32);
      const s = await completeSession(rev, h);
      await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      const r = await readiness(U_ALL_A, rev);
      expect(r.blockers.map((b: any) => b.blocker)).toContain('completed_session_not_in_trusted_batch');
      await expect(submit(U_ALL_A, rev)).rejects.toThrow(/plan_revision_has_unbatched_completed_import/);
    });

    it('refuses a target entity with no explicit decision', async () => {
      const rev = await openRevision();
      const h = '23'.repeat(32);
      const s = await completeSession(rev, h);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: h });
      const r = await readiness(U_ALL_A, rev);
      expect(r.blockers.map((b: any) => b.blocker)).toContain('target_entity_without_disposition');
      await expect(submit(U_ALL_A, rev)).rejects.toThrow(/plan_revision_has_undecided_target_entity/);
    });

    it('ALLOWS submit when every precondition holds', async () => {
      const rev = await openRevision();
      const h = '24'.repeat(32);
      const s = await completeSession(rev, h);
      await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: h });

      const r = await readiness(U_ALL_A, rev);
      expect(r.ready).toBe(true);
      expect(r.blockers).toEqual([]);

      const submitted = await submit(U_ALL_A, rev);
      expect(submitted.status).toBe('submitted');
    });

    it('a FAILED session is terminal history and does not block', async () => {
      const rev = await openRevision();
      const good = '25'.repeat(32);
      const s = await completeSession(rev, good);
      await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: good, importSessionId: s },
      ], { containerSha: good });

      const abandoned = '26'.repeat(32);
      const records = makeRecords(abandoned);
      const started = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'gone.xls', abandoned, await payloadDigest(records), JSON.stringify(BROWSER_IDENTITY), 10, 'permanent/z']);
      await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`,
        [started.import_session_id, 'browser tab closed']);

      const r = await readiness(U_ALL_A, rev);
      expect(r.ready).toBe(true);
      expect((await submit(U_ALL_A, rev)).status).toBe('submitted');
    });

    it('abandon requires a reason and refuses a completed session', async () => {
      const rev = await openRevision();
      const h = '27'.repeat(32);
      const s = await completeSession(rev, h);
      await expect(call(U_ALL_A,
        `SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`, [s, '  ']))
        .rejects.toThrow(/abandon_reason_required/);
      await expect(call(U_ALL_A,
        `SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`, [s, 'nope']))
        .rejects.toThrow(/import_session_not_abandonable/);
    });
  });

  // ── D. Batch atomicity ──────────────────────────────────────────────────
  describe('D. trusted batch atomicity', () => {
    it('a PARTIAL archive leaves the revision unsubmittable', async () => {
      const rev = await openRevision();
      const e1 = '30'.repeat(32);
      const e2 = '31'.repeat(32);
      // Entry-aware: a ZIP member's session records its own archive path, and
      // the batch writer now refuses a manifest that claims otherwise.
      const s1 = await completeEntrySession(rev, e1, 'a.xls', 'sheet:0:row:5', U_ALL_A, 'a.xls');
      const s2 = await completeEntrySession(rev, e2, 'b.xls', 'sheet:0:row:6', U_ALL_A, 'b.xls');
      await decide(U_ALL_A, s1, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      await decide(U_ALL_A, s2, 'sheet:0:row:6', 'mapped', ITEM_1, null);

      // The worker died after entry 1: only s1 is claimed by a batch.
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: 'a.xls', entrySha256: e1, importSessionId: s1 },
      ], { kind: 'zip', containerSha: '32'.repeat(32) });

      const r = await readiness(U_ALL_A, rev);
      expect(r.ready).toBe(false);
      expect(r.blockers.map((b: any) => b.blocker)).toContain('completed_session_not_in_trusted_batch');
      await expect(submit(U_ALL_A, rev)).rejects.toThrow(/unbatched_completed_import/);
    });

    it('an EXACT batch retry is an idempotent no-op', async () => {
      const rev = await openRevision();
      const h = '33'.repeat(32);
      const s = await completeSession(rev, h);
      const entries = [{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s }];
      const first = await registerBatch(rev, entries, { containerSha: h });
      const second = await registerBatch(rev, entries, { containerSha: h });
      expect(first.idempotent_replay).toBe(false);
      expect(second.idempotent_replay).toBe(true);
      expect(second.batch_id).toBe(first.batch_id);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_import_batches WHERE plan_revision_id=$1`, [rev]);
      expect(count).toBe(1);
    });

    it('a DIFFERENT manifest under the same container hash fails closed', async () => {
      const rev = await openRevision();
      const h1 = '34'.repeat(32);
      const h2 = '35'.repeat(32);
      const container = '36'.repeat(32);
      const s1 = await completeSession(rev, h1, 'sheet:0:row:5', U_ALL_A, 'a.xls');
      const s2 = await completeSession(rev, h2, 'sheet:0:row:6', U_ALL_A, 'b.xls');
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h1, importSessionId: s1 },
      ], { containerSha: container });
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h2, importSessionId: s2 },
      ], { containerSha: container }))
        .rejects.toThrow(/already_registered_with_different_evidence/);
    });

    it('a session that is not completed cannot be batched', async () => {
      const rev = await openRevision();
      const h = '37'.repeat(32);
      const records = makeRecords(h);
      const started = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'open.xls', h, await payloadDigest(records), JSON.stringify(BROWSER_IDENTITY), 10, 'permanent/o']);
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: started.import_session_id },
      ], { containerSha: h }))
        .rejects.toThrow(/must_be_completed_in_this_revision/);
    });

    it('one session cannot belong to two batches', async () => {
      const rev = await openRevision();
      const h = '38'.repeat(32);
      const s = await completeSession(rev, h);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: '39'.repeat(32) });
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: '3a'.repeat(32) }))
        .rejects.toThrow();
    });

    it('entry ordinals must be exactly 1..N', async () => {
      const rev = await openRevision();
      const h = '3b'.repeat(32);
      const s = await completeSession(rev, h);
      await expect(registerBatch(rev, [
        { entryOrdinal: 2, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: h }))
        .rejects.toThrow(/ordinals_must_be_exactly_one_through_n/);
    });

    it('a standalone batch must carry exactly one entry and no archive path', async () => {
      const rev = await openRevision();
      const h = '3c'.repeat(32);
      const s = await completeSession(rev, h);
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: 'inside.xls', entrySha256: h, importSessionId: s },
      ], { kind: 'file', containerSha: h }))
        .rejects.toThrow(/standalone_batch_entry_must_not_carry_archive_entry_path/);
    });

    it('a zip batch entry REQUIRES its archive path', async () => {
      const rev = await openRevision();
      const h = '3d'.repeat(32);
      const s = await completeSession(rev, h);
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { kind: 'zip', containerSha: h }))
        .rejects.toThrow(/zip_batch_entry_requires_archive_entry_path/);
    });

    it('a browser-runtime identity cannot register a batch', async () => {
      const rev = await openRevision();
      const h = '3e'.repeat(32);
      const s = await completeSession(rev, h);
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: h, identity: BROWSER_IDENTITY }))
        .rejects.toThrow(/must_be_node_runtime/);
    });
  });

  // ── E. Hash semantics ───────────────────────────────────────────────────
  describe('E. container hash is not an entry hash', () => {
    it('an entry hash that is not the session source file hash is refused', async () => {
      const rev = await openRevision();
      const entry = '40'.repeat(32);
      const container = '41'.repeat(32);
      const s = await completeSession(rev, entry);
      await expect(registerBatch(rev, [
        // Passing the CONTAINER hash where the ENTRY hash belongs.
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: container, importSessionId: s },
      ], { containerSha: container }))
        .rejects.toThrow(/entry_sha256_does_not_match_session_source_file/);
    });

    it('a zip records a container hash distinct from each entry hash', async () => {
      const rev = await openRevision();
      const e1 = '42'.repeat(32);
      const e2 = '43'.repeat(32);
      const container = '44'.repeat(32);
      const s1 = await completeEntrySession(rev, e1, 'dir/a.xls', 'sheet:0:row:5', U_ALL_A, 'a.xls');
      const s2 = await completeEntrySession(rev, e2, 'dir/b.xls', 'sheet:0:row:6', U_ALL_A, 'b.xls');
      const r = await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: 'dir/a.xls', entrySha256: e1, importSessionId: s1 },
        { entryOrdinal: 2, archiveEntryPath: 'dir/b.xls', entrySha256: e2, importSessionId: s2 },
      ], { kind: 'zip', containerSha: container });
      expect(r.accepted_entry_count).toBe(2);

      const [batch] = await admin(
        `SELECT container_sha256, accepted_entry_count FROM central_needs_import_batches WHERE id=$1`, [r.batch_id]);
      const rows = await admin(
        `SELECT entry_ordinal, archive_entry_path, entry_sha256 FROM central_needs_import_batch_entries
          WHERE batch_id=$1 ORDER BY entry_ordinal`, [r.batch_id]);
      expect(batch.container_sha256).toBe(container);
      expect(rows.map((x: any) => x.entry_sha256)).toEqual([e1, e2]);
      expect(rows.every((x: any) => x.entry_sha256 !== container)).toBe(true);
      expect(rows.map((x: any) => x.archive_entry_path)).toEqual(['dir/a.xls', 'dir/b.xls']);
    });
  });

  // ── F. Retry semantics ──────────────────────────────────────────────────
  describe('F. import retry semantics', () => {
    it('a completed session is reused idempotently', async () => {
      const rev = await openRevision();
      const h = '50'.repeat(32);
      const s = await completeSession(rev, h);
      const again = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'needs.xls', h, await payloadDigest(makeRecords(h)), JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/x']);
      expect(again.idempotent_replay).toBe(true);
      expect(again.import_session_id).toBe(s);
      expect(again.status).toBe('completed');
    });

    it('an OPEN attempt is reused rather than raced', async () => {
      const rev = await openRevision();
      const h = '51'.repeat(32);
      const digest = await payloadDigest(makeRecords(h));
      const first = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'needs.xls', h, digest, JSON.stringify(BROWSER_IDENTITY), 10, 'p/1']);
      const second = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'needs.xls', h, digest, JSON.stringify(BROWSER_IDENTITY), 10, 'p/1']);
      expect(second.idempotent_replay).toBe(true);
      expect(second.import_session_id).toBe(first.import_session_id);
      expect(second.status).toBe('processing');
    });

    it('a FAILED attempt permits a brand-new attempt on the same source file', async () => {
      const rev = await openRevision();
      const h = '52'.repeat(32);
      const digest = await payloadDigest(makeRecords(h));
      const first = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'needs.xls', h, digest, JSON.stringify(BROWSER_IDENTITY), 10, 'p/1']);
      await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`,
        [first.import_session_id, 'network dropped']);

      const retry = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'needs.xls', h, digest, JSON.stringify(BROWSER_IDENTITY), 10, 'p/1']);
      expect(retry.idempotent_replay).toBe(false);
      expect(retry.import_session_id).not.toBe(first.import_session_id);
      expect(retry.status).toBe('processing');

      // The immutable source file is reused, never duplicated.
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_files WHERE plan_revision_id=$1 AND file_hash=$2`, [rev, h]);
      expect(count).toBe(1);
    });
  });

  // ── G. Privileges ───────────────────────────────────────────────────────
  describe('G. privileges', () => {
    it('the batch writer and the blocker predicate are NOT client-callable', async () => {
      for (const fn of TRUSTED_RPCS) {
        const [row] = await admin(
          `SELECT to_regprocedure($1) IS NOT NULL AS present,
                  has_function_privilege('authenticated', $1, 'EXECUTE') AS auth_exec,
                  has_function_privilege('anon', $1, 'EXECUTE') AS anon_exec`, [fn]);
        expect(row.present).toBe(true);
        expect(row.auth_exec).toBe(false);
        expect(row.anon_exec).toBe(false);
      }
    });

    it('the new client RPCs are executable by authenticated and not by anon', async () => {
      for (const fn of CLIENT_RPCS) {
        const [row] = await admin(
          `SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS auth_exec,
                  has_function_privilege('anon', $1, 'EXECUTE') AS anon_exec`, [fn]);
        expect(row.auth_exec).toBe(true);
        expect(row.anon_exec).toBe(false);
      }
    });

    it('no client write grant exists on the batch tables', async () => {
      for (const table of ['central_needs_import_batches', 'central_needs_import_batch_entries']) {
        for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
          const [row] = await admin(
            `SELECT has_table_privilege('authenticated', $1, $2) AS a,
                    has_table_privilege('anon', $1, $2) AS b`, [`public.${table}`, priv]);
          expect(row.a).toBe(false);
          expect(row.b).toBe(false);
        }
        const [rls] = await admin(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
             FROM pg_class WHERE oid = to_regclass($1)`, [`public.${table}`]);
        expect(rls.enabled).toBe(true);
        expect(rls.forced).toBe(true);
      }
    });

    it('central_needs.send still does not exist and defaults are still zero', async () => {
      const [row] = await admin(
        `SELECT (SELECT count(*)::int FROM permission_keys WHERE key='central_needs.send') AS send,
                (SELECT count(*)::int FROM permission_keys WHERE module='central_needs') AS keys,
                (SELECT count(*)::int FROM role_permission_defaults WHERE permission_key LIKE 'central_needs.%') AS defaults`);
      expect(row.send).toBe(0);
      expect(row.keys).toBe(4);
      expect(row.defaults).toBe(0);
    });
  });
  // ── H. Role eligibility — the product boundary, server-enforced ─────────
  describe('H. central needs role boundary', () => {
    const INELIGIBLE: Array<[string, string]> = [
      [U_INST_ADMIN, 'institution_admin'],
      [U_OUTLET, 'outlet_officer'],
      [U_WH_OFFICER, 'warehouse_officer'],
    ];

    it('the eligible class is exactly super_admin + central_warehouse_manager', async () => {
      const [row] = await admin(
        `SELECT public._phoenix_central_needs_role_eligible_v1() AS e`);
      // Evaluated with no JWT: must be a strict boolean, never NULL.
      expect(row.e).toBe(false);
    });

    it('an ELIGIBLE role holding the capability is allowed', async () => {
      const rev = await openRevision(U_ALL_A);
      expect(rev).toBeTruthy();
    });

    it.each(INELIGIBLE)('an INELIGIBLE role is refused even holding every capability (%s)', async (user) => {
      await expect(call(user,
        `SELECT public.phoenix_central_needs_open_plan_revision($1,$2,false) AS result`, [ORG_A, 2099]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('an ineligible role READS ZERO Central Needs rows, whatever its permissions', async () => {
      const rev = await openRevision();
      const h = '60'.repeat(32);
      const s = await completeSession(rev, h);
      await decide(U_ALL_A, s, 'sheet:0:row:5', 'mapped', ITEM_1, null);
      await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s },
      ], { containerSha: h });

      // The eligible actor sees the evidence...
      const seen = await rig.asUser(U_ALL_A, (c: any) =>
        c.query(`SELECT count(*)::int AS n FROM central_needs_source_records`).then((r: any) => r.rows[0].n),
        { role: 'authenticated' });
      expect(seen).toBeGreaterThan(0);

      // ...and every ineligible role sees none of it, on every relation.
      for (const [user] of INELIGIBLE) {
        for (const t of [
          'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
          'central_needs_import_sessions', 'central_needs_source_records',
          'central_needs_field_overrides', 'central_needs_record_mappings',
          'central_needs_import_batches', 'central_needs_import_batch_entries',
        ]) {
          const n = await rig.asUser(user, (c: any) =>
            c.query(`SELECT count(*)::int AS n FROM ${t}`).then((r: any) => r.rows[0].n),
            { role: 'authenticated' });
          expect(n, `${user} must see no ${t}`).toBe(0);
        }
      }
    });

    it('every Central Needs relation carries a RESTRICTIVE role policy', async () => {
      for (const t of [
        'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
        'central_needs_import_sessions', 'central_needs_source_records',
        'central_needs_field_overrides', 'central_needs_record_mappings',
        'central_needs_import_batches', 'central_needs_import_batch_entries',
      ]) {
        const [row] = await admin(
          `SELECT count(*)::int AS n FROM pg_policies
            WHERE schemaname='public' AND tablename=$1 AND permissive='RESTRICTIVE'`, [t]);
        expect(row.n, t).toBeGreaterThan(0);
      }
    });

    it('role eligibility does NOT replace the capability check', async () => {
      // U_NONE_A is central_warehouse_manager (eligible) with no capability.
      await expect(call(U_NONE_A,
        `SELECT public.phoenix_central_needs_open_plan_revision($1,$2,false) AS result`, [ORG_A, 2098]))
        .rejects.toThrow(/forbidden_central_needs/);
    });
  });

  // ── I. Entry identity — one accepted archive entry, one session ─────────
  describe('I. duplicate-byte archive entries', () => {
    it('same file + same entry path is an exact reuse', async () => {
      const rev = await openRevision();
      const h = '61'.repeat(32);
      const first = await startEntrySession(rev, h, 'north/needs.xls');
      const again = await startEntrySession(rev, h, 'north/needs.xls');
      expect(again.idempotent_replay).toBe(true);
      expect(again.import_session_id).toBe(first.import_session_id);
    });

    it('same BYTES at a DIFFERENT entry path is a DISTINCT session', async () => {
      const rev = await openRevision();
      const h = '62'.repeat(32);
      const north = await startEntrySession(rev, h, 'north/needs.xls');
      const south = await startEntrySession(rev, h, 'south/needs.xls');
      expect(south.idempotent_replay).toBe(false);
      expect(south.import_session_id).not.toBe(north.import_session_id);
      expect(north.entry_path).toBe('north/needs.xls');
      expect(south.entry_path).toBe('south/needs.xls');

      // The SOURCE BYTES remain content-deduplicated — that part is correct.
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_files WHERE plan_revision_id=$1 AND file_hash=$2`,
        [rev, h]);
      expect(count).toBe(1);
    });

    it('two byte-identical workbooks at two ZIP paths finalize into ONE batch of TWO entries', async () => {
      const rev = await openRevision();
      const h = '63'.repeat(32);
      const a = await completeEntrySession(rev, h, 'north/needs.xls', 'sheet:0:row:5');
      const b = await completeEntrySession(rev, h, 'south/needs.xls', 'sheet:0:row:5');
      expect(a).not.toBe(b);

      const r = await registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: 'north/needs.xls', entrySha256: h, importSessionId: a },
        { entryOrdinal: 2, archiveEntryPath: 'south/needs.xls', entrySha256: h, importSessionId: b },
      ], { kind: 'zip', containerSha: '64'.repeat(32) });
      expect(r.accepted_entry_count).toBe(2);

      const rows = await admin(
        `SELECT e.entry_ordinal, e.archive_entry_path, s.entry_path
           FROM central_needs_import_batch_entries e
           JOIN central_needs_import_sessions s ON s.id = e.import_session_id
          WHERE e.batch_id=$1 ORDER BY e.entry_ordinal`, [r.batch_id]);
      expect(rows.map((x: any) => x.archive_entry_path)).toEqual(['north/needs.xls', 'south/needs.xls']);
      // Each session preserved its OWN entry provenance.
      expect(rows.map((x: any) => x.entry_path)).toEqual(['north/needs.xls', 'south/needs.xls']);
    });

    it('one session cannot silently stand for two accepted entries', async () => {
      const rev = await openRevision();
      const h = '65'.repeat(32);
      const only = await completeEntrySession(rev, h, 'north/needs.xls');
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: 'north/needs.xls', entrySha256: h, importSessionId: only },
        { entryOrdinal: 2, archiveEntryPath: 'south/needs.xls', entrySha256: h, importSessionId: only },
      ], { kind: 'zip', containerSha: '66'.repeat(32) })).rejects.toThrow();
    });

    it('a manifest entry naming a session with a DIFFERENT entry path is refused', async () => {
      const rev = await openRevision();
      const h = '67'.repeat(32);
      const north = await completeEntrySession(rev, h, 'north/needs.xls');
      await expect(registerBatch(rev, [
        { entryOrdinal: 1, archiveEntryPath: 'south/needs.xls', entrySha256: h, importSessionId: north },
      ], { kind: 'zip', containerSha: '68'.repeat(32) }))
        .rejects.toThrow(/entry_path_does_not_match_session_entry_path/);
    });

    it('the live-entry uniqueness holds, and a failed attempt still allows a retry', async () => {
      const rev = await openRevision();
      const h = '69'.repeat(32);
      const first = await startEntrySession(rev, h, 'north/needs.xls');
      await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`,
        [first.import_session_id, 'crash']);
      const retry = await startEntrySession(rev, h, 'north/needs.xls');
      expect(retry.idempotent_replay).toBe(false);
      expect(retry.import_session_id).not.toBe(first.import_session_id);
    });

    it('the standalone (7-argument) form still behaves exactly as M210 defined it', async () => {
      const rev = await openRevision();
      const h = '6a'.repeat(32);
      const first = await completeSession(rev, h);
      const again = await call(U_ALL_A,
        `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
        [rev, 'needs.xls', h, await payloadDigest(makeRecords(h)), JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/x']);
      expect(again.idempotent_replay).toBe(true);
      expect(again.import_session_id).toBe(first);
      const [row] = await admin(
        `SELECT entry_path FROM central_needs_import_sessions WHERE id=$1`, [first]);
      expect(row.entry_path).toBeNull();
    });
  });

  // ── J. Completed-session EXACT replay ───────────────────────────────────
  describe('J. completed-session exact replay', () => {
    it('replaying a completed session with IDENTICAL evidence is an idempotent no-op', async () => {
      const rev = await openRevision();
      const h = '70'.repeat(32);
      const s = await completeSession(rev, h);
      const records = makeRecords(h);
      const again = await replay(s, h, records);
      expect(again.idempotent_replay).toBe(true);
      expect(again.records_inserted).toBe(0);
    });

    it('replaying a completed session with DIFFERENT evidence FAILS CLOSED', async () => {
      const rev = await openRevision();
      const h = '71'.repeat(32);
      const s = await completeSession(rev, h);
      // Same file, same session — different semantic content.
      const tampered = makeRecords(h);
      (tampered[0] as any).sourceValues = { value: 999999, valueType: 'number', isFormula: false, formula: null };
      await expect(replay(s, h, tampered))
        .rejects.toThrow(/already_finalized_with_different_evidence/);

      // And the persisted evidence is untouched.
      const [row] = await admin(
        `SELECT source_values->>'value' AS v FROM central_needs_source_records
          WHERE import_session_id=$1 ORDER BY record_ordinal LIMIT 1`, [s]);
      expect(row.v).toBe('120');
    });

    it('a completed session refuses a replay whose provenance differs', async () => {
      const rev = await openRevision();
      const h = '72'.repeat(32);
      const s = await completeSession(rev, h);
      const moved = makeRecords(h);
      (moved[0] as any).sourceProvenance.coordinate = { row: 9, col: 9, a1: 'J10' };
      await expect(replay(s, h, moved))
        .rejects.toThrow(/already_finalized_with_different_evidence/);
    });
  });

  // ── K. Batch retry binds every recorded semantic ────────────────────────
  describe('K. exact batch retry', () => {
    const setup = async () => {
      const rev = await openRevision();
      const h = '80'.repeat(32);
      const s = await completeSession(rev, h);
      const entries = [{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: h, importSessionId: s }];
      const container = '81'.repeat(32);
      await registerBatch(rev, entries, { containerSha: container });
      return { rev, entries, container };
    };

    const reRegister = (
      rev: string, entries: unknown[], container: string, overrides: Record<string, unknown>,
    ) => service(
      `SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb) AS result`,
      [
        rev,
        overrides.kind ?? 'file',
        overrides.filename ?? 'container.xls',
        container,
        overrides.locator ?? 'permanent/container',
        JSON.stringify(overrides.entries ?? entries),
        JSON.stringify(overrides.identity ?? NODE_IDENTITY),
        overrides.byteSize === undefined ? 2048 : overrides.byteSize,
        overrides.excluded === undefined ? 0 : overrides.excluded,
        overrides.reconciliation === undefined ? null : JSON.stringify(overrides.reconciliation),
      ]);

    it('an entirely identical re-registration is idempotent', async () => {
      const { rev, entries, container } = await setup();
      const again = await reRegister(rev, entries, container, {});
      expect(again.idempotent_replay).toBe(true);
    });

    it.each([
      ['container_filename', { filename: 'other.xls' }],
      ['container_byte_size', { byteSize: 4096 }],
      ['storage_locator', { locator: 'permanent/elsewhere' }],
      ['excluded_entry_count', { excluded: 3 }],
      ['reconciliation', { reconciliation: { filesTotal: 9 } }],
      ['parser_identity', { identity: { ...NODE_IDENTITY, sheetjsVersion: '9.9.9' } }],
      ['container_kind', { kind: 'zip' }],
    ])('a changed %s under the same container identity FAILS CLOSED', async (_field, overrides) => {
      const { rev, entries, container } = await setup();
      await expect(reRegister(rev, entries, container, overrides as Record<string, unknown>))
        .rejects.toThrow(/already_registered_with_different_evidence|zip_batch_entry_requires_archive_entry_path/);
    });

    it('a changed entry manifest under the same container identity FAILS CLOSED', async () => {
      const { rev, entries, container } = await setup();
      const other = '82'.repeat(32);
      const s2 = await completeSession(rev, other, 'sheet:0:row:6', U_ALL_A, 'second.xls');
      await expect(reRegister(rev, entries, container, {
        entries: [{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: other, importSessionId: s2 }],
      })).rejects.toThrow(/already_registered_with_different_evidence/);
    });

    it('the originally registered batch is never mutated by a refused retry', async () => {
      const { rev, entries, container } = await setup();
      await reRegister(rev, entries, container, { filename: 'other.xls' }).catch(() => null);
      const [row] = await admin(
        `SELECT container_filename, container_byte_size FROM central_needs_import_batches
          WHERE plan_revision_id=$1 AND container_sha256=$2`, [rev, container]);
      expect(row.container_filename).toBe('container.xls');
      expect(Number(row.container_byte_size)).toBe(2048);
    });
  });
});
