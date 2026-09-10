/**
 * CN-1B / M210 — CENTRAL NEEDS WORKFLOW RPCs — DYNAMIC proof against a real
 * disposable Postgres with 001->210 applied in order.
 *
 *   A. Authentication  — anon and unauthenticated callers are refused.
 *   B. Permission      — each RPC demands its own key; approval demands
 *                        central_needs.approve specifically.
 *   C. Organization    — same-org allowed, cross-org refused, archived
 *                        organization refused, nonexistent refused.
 *   D. State machine   — legal transitions succeed, illegal fail closed,
 *                        approved history preserved, and a REJECTED revision
 *                        does not dead-end the plan year.
 *   E. TRUST BOUNDARY  — an authenticated central_needs.import holder cannot
 *                        manufacture authoritative evidence by any route.
 *   F. Immutability    — source evidence never changes; overrides carry real
 *                        lineage; a reason is mandatory.
 *   G. Audit           — correct attribution, no orphan, no leakage.
 *   H. Privileges      — full ACL catalog for PUBLIC/anon/authenticated/service_role.
 *   I. Movement        — no stock, no transfer, no send permission.
 *   J. REVIEW REPAIRS  — the six blockers from independent review: archived-org
 *                        bypass, source identity collisions, mapping/override
 *                        lineage, provenance binding, replay idempotency, and
 *                        the rejected-revision dead-end.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000210001';
const ORG_B = '00000000-0000-0000-0000-000000210002';
const ORG_ARCHIVED = '00000000-0000-0000-0000-000000210003';
const ORG_LATE = '00000000-0000-0000-0000-000000210004'; // archived mid-flight
const ORG_ABSENT = '00000000-0000-0000-0000-0000002109ff';

const U_ALL_A = '00000000-0000-0000-0000-000000210401';
const U_IMPORT_A = '00000000-0000-0000-0000-000000210402';
const U_EDIT_A = '00000000-0000-0000-0000-000000210403';
const U_APPROVE_A = '00000000-0000-0000-0000-000000210404';
const U_NONE_A = '00000000-0000-0000-0000-000000210405';
const U_ALL_B = '00000000-0000-0000-0000-000000210406';
const U_INST_A = '00000000-0000-0000-0000-000000210407';
const U_ALL_ARCH = '00000000-0000-0000-0000-000000210408';
const U_ALL_LATE = '00000000-0000-0000-0000-000000210409';
const U_GHOST = '00000000-0000-0000-0000-0000002104ff';

const ITEM_1 = '00000000-0000-0000-0000-000000210801';
const ITEM_2 = '00000000-0000-0000-0000-000000210802';

const H = (c: string) => c.repeat(64);
const BOGUS_DIGEST = H('d');

const NODE_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};
const BROWSER_IDENTITY = { ...NODE_IDENTITY, runtime: 'browser_worker' };

const CENTRAL_NEEDS_TABLES = [
  'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
  'central_needs_import_sessions', 'central_needs_source_records',
  'central_needs_field_overrides', 'central_needs_record_mappings',
] as const;

const CLIENT_RPCS = [
  'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
  'public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text)',
  'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)',
  'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)',
  'public.phoenix_central_needs_submit_revision(uuid)',
  'public.phoenix_central_needs_approve_revision(uuid)',
  'public.phoenix_central_needs_reject_revision(uuid, text)',
];
const TRUSTED_RPC = 'public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)';
const INTERNAL_HELPERS = [
  'public._phoenix_central_needs_assert_org_live_v1(uuid)',
  'public._phoenix_central_needs_guard_v1(uuid, text)',
  'public._phoenix_central_needs_load_revision_v1(uuid)',
  'public._phoenix_central_needs_assert_draft_v1(uuid, text)',
  'public._phoenix_central_needs_semantic_digest_v1(uuid)',
  'public._phoenix_central_needs_payload_digest_v1(jsonb)',
  'public._phoenix_central_needs_assert_payload_v1(jsonb, text)',
];

run('CN-1B/210 central-needs workflow RPCs — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  const probe = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params), { role });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /**
   * CN-2A SourceValueRecordDraft objects for a given file. Provenance must
   * fingerprint the session's own source file, and carries extractedAt — the
   * one field the digest normalizes away — deliberately DIFFERENT per call, so
   * every passing agreement test also proves the normalization works.
   */
  const makeRecords = (fileHash: string, quantity = '120') => ([
    {
      targetEntity: 'sheet:0:row:5', fieldName: 'quantity',
      sourceValues: { raw: quantity, normalized: Number(quantity) },
      sourceProvenance: {
        fileFingerprintSha256: fileHash, originalFilename: 'needs.xls', parserVersion: '0.20.3',
        sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
        coordinate: { row: 4, col: 2, a1: 'C5' }, extractedAt: new Date().toISOString(),
      },
    },
    {
      targetEntity: 'sheet:0:row:5', fieldName: 'item_name',
      sourceValues: { raw: 'Paracetamol 500mg' },
      sourceProvenance: {
        fileFingerprintSha256: fileHash, originalFilename: 'needs.xls', parserVersion: '0.20.3',
        sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
        coordinate: { row: 4, col: 1, a1: 'B5' }, extractedAt: new Date().toISOString(),
      },
    },
  ]);

  /**
   * The digest the DATABASE will compute, derived with the same expression the
   * migration uses — never borrowed from the function under test.
   */
  const expectedDigest = async (records: unknown[]): Promise<string> => {
    const [row] = await admin(
      `SELECT encode(sha256(convert_to(COALESCE(string_agg(
           e.ord::text || E'\\x1F' || btrim(e.r->>'targetEntity') || E'\\x1F' ||
           btrim(e.r->>'fieldName') || E'\\x1F' || (e.r->'sourceValues')::text || E'\\x1F' ||
           COALESCE(((e.r->'sourceProvenance') - 'extractedAt')::text, ''),
           E'\\x1E' ORDER BY e.ord), ''), 'UTF8')), 'hex') AS d
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(r, ord)`,
      [JSON.stringify(records)]);
    return row.d;
  };

  const openRevision = (u: string, org: string, year: number, next = false) =>
    call(u, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result', [org, year, next]);

  const startImport = (u: string, rev: string, hash: string, preview: string, name = 'needs.xls') =>
    call(u, 'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5) AS result',
      [rev, name, hash, preview, JSON.stringify(BROWSER_IDENTITY)]);

  const applyReplay = (session: string, fileHash: string, records: unknown[], identity: unknown = NODE_IDENTITY) =>
    rig.asUser(null, (c: any) => c.query(
      'SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3,$4) AS result',
      [session, fileHash, JSON.stringify(records), JSON.stringify(identity)]).then((r: any) => r.rows[0].result),
      { role: 'service_role', commit: true });

  const probeReplayAs = (role: string, userId: string | null, session: string, fileHash: string,
    records: unknown[], identity: unknown = NODE_IDENTITY) =>
    rig.asUser(userId, (c: any) => c.query(
      'SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3,$4)',
      [session, fileHash, JSON.stringify(records), JSON.stringify(identity)]), { role });

  /** Open a revision, start a session and apply a trusted replay end to end. */
  const importedSession = async (org: string, user: string, year: number, fileHash: string, name = 'needs.xls') => {
    const r = await openRevision(user, org, year);
    const recs = makeRecords(fileHash);
    const d = await expectedDigest(recs);
    const s = await startImport(user, r.plan_revision_id, fileHash, d, name);
    await applyReplay(s.import_session_id, fileHash, recs);
    return { revision: r.plan_revision_id, session: s.import_session_id, records: recs, digest: d };
  };

  let revA = '';
  let sessionA = '';
  let planA = '';
  let digestA = '';
  let recordsA: unknown[] = [];

  beforeAll(async () => {
    rig = await buildRig({ upTo: 210 });

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','CN210-A','أ','p210-a','care_institution','hospital'),
        ('${ORG_B}','CN210-B','ب','p210-b','care_institution','hospital'),
        ('${ORG_ARCHIVED}','CN210-ARCH','ج','p210-arch','care_institution','hospital'),
        ('${ORG_LATE}','CN210-LATE','د','p210-late','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_ALL_A}','p210-all-a@rig'),('${U_IMPORT_A}','p210-imp-a@rig'),
        ('${U_EDIT_A}','p210-edit-a@rig'),('${U_APPROVE_A}','p210-appr-a@rig'),
        ('${U_NONE_A}','p210-none-a@rig'),('${U_ALL_B}','p210-all-b@rig'),
        ('${U_INST_A}','p210-inst-a@rig'),('${U_ALL_ARCH}','p210-all-arch@rig'),
        ('${U_ALL_LATE}','p210-all-late@rig')
        ON CONFLICT (id) DO NOTHING;`);

      for (const [u, org, role] of [
        [U_ALL_A, ORG_A, 'central_warehouse_manager'], [U_IMPORT_A, ORG_A, 'central_warehouse_manager'],
        [U_EDIT_A, ORG_A, 'central_warehouse_manager'], [U_APPROVE_A, ORG_A, 'central_warehouse_manager'],
        [U_NONE_A, ORG_A, 'central_warehouse_manager'], [U_ALL_B, ORG_B, 'central_warehouse_manager'],
        [U_INST_A, ORG_A, 'institution_admin'], [U_ALL_ARCH, ORG_ARCHIVED, 'central_warehouse_manager'],
        [U_ALL_LATE, ORG_LATE, 'central_warehouse_manager'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1,status='active',organization_id=$2 WHERE id=$3`, [role, org, u]);
      }

      const grants: Array<[string, string]> = [];
      for (const k of ['view', 'import', 'edit', 'approve']) {
        for (const u of [U_ALL_A, U_ALL_B, U_ALL_ARCH, U_ALL_LATE]) grants.push([u, `central_needs.${k}`]);
      }
      grants.push([U_IMPORT_A, 'central_needs.import'], [U_IMPORT_A, 'central_needs.view']);
      grants.push([U_EDIT_A, 'central_needs.edit'], [U_EDIT_A, 'central_needs.view']);
      grants.push([U_APPROVE_A, 'central_needs.approve'], [U_APPROVE_A, 'central_needs.view']);
      for (const [p, k] of grants) {
        await c.query(
          `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
             ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [p, k]);
      }

      await c.query(`INSERT INTO central_items (id,name,name_ar,unit) VALUES
        ('${ITEM_1}','Paracetamol 500mg','باراسيتامول','box'),
        ('${ITEM_2}','Amoxicillin 250mg','أموكسيسيلين','box')
        ON CONFLICT (id) DO NOTHING;`);

      // Archive the ONLY way M202 permits: archived_at is database-owned, so a
      // legal status transition is the sole path. Asserted, or the tests are vacuous.
      await c.query(`UPDATE organizations SET status = 'inactive' WHERE id = '${ORG_ARCHIVED}'`);
      const [{ archived_at: stamped }] = (await c.query(
        `SELECT archived_at FROM organizations WHERE id = '${ORG_ARCHIVED}'`)).rows;
      if (!stamped) throw new Error('fixture precondition failed: ORG_ARCHIVED was not actually archived');
    });

    recordsA = makeRecords(H('a'));
    digestA = await expectedDigest(recordsA);
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ==========================================================================
  // D. Happy path
  // ==========================================================================
  describe('D. workflow happy path', () => {
    it('opens a plan and its first revision', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2028);
      expect(r.revision_number).toBe(1);
      expect(r.status).toBe('draft');
      revA = r.plan_revision_id;
      planA = r.plan_id;
    });

    it('re-opening the same year returns the same draft (idempotent)', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2028);
      expect(r.idempotent_replay).toBe(true);
      expect(r.plan_revision_id).toBe(revA);
    });

    it('a client starts a session carrying only a PROVISIONAL preview digest', async () => {
      const r = await startImport(U_ALL_A, revA, H('a'), digestA);
      expect(r.status).toBe('processing');
      sessionA = r.import_session_id;
      const [row] = await admin(
        `SELECT status, preview_digest, authoritative_digest FROM central_needs_import_sessions WHERE id=$1`, [sessionA]);
      expect(row.preview_digest).toBe(digestA);
      expect(row.authoritative_digest).toBeNull();
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id=$1`, [sessionA]);
      expect(count).toBe(0);
    });

    it('the TRUSTED replay writes evidence, recomputes the digest and finalizes', async () => {
      const r = await applyReplay(sessionA, H('a'), recordsA);
      expect(r.status).toBe('completed');
      expect(r.records_inserted).toBe(2);
      expect(r.authoritative_digest).toBe(digestA);
      const [row] = await admin(
        `SELECT status, authoritative_digest, parser_identity FROM central_needs_import_sessions WHERE id=$1`, [sessionA]);
      expect(row.status).toBe('completed');
      expect(row.parser_identity.runtime).toBe('node');
    });

    it('persisted records match the replay payload, in CN-2A order', async () => {
      const rows = await admin(
        `SELECT record_ordinal, target_entity, field_name, source_values, source_provenance
           FROM central_needs_source_records WHERE import_session_id=$1 ORDER BY record_ordinal`, [sessionA]);
      expect(rows.map((r: any) => r.record_ordinal)).toEqual([1, 2]);
      rows.forEach((row: any, i: number) => {
        expect(row.target_entity).toBe((recordsA[i] as any).targetEntity);
        expect(row.field_name).toBe((recordsA[i] as any).fieldName);
        expect(row.source_values).toEqual((recordsA[i] as any).sourceValues);
        expect(row.source_provenance).toEqual((recordsA[i] as any).sourceProvenance);
      });
      const [{ d }] = await admin(`SELECT public._phoenix_central_needs_semantic_digest_v1($1) AS d`, [sessionA]);
      expect(d).toBe(digestA);
    });

    it('maps a session entity onto a canonical central item', async () => {
      const r = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result',
        [sessionA, 'sheet:0:row:5', ITEM_1]);
      expect(r.central_item_id).toBe(ITEM_1);
    });

    it('re-mapping records the previous link', async () => {
      const r = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result',
        [sessionA, 'sheet:0:row:5', ITEM_2]);
      expect(r.previous_central_item_id).toBe(ITEM_1);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_record_mappings WHERE import_session_id=$1`, [sessionA]);
      expect(count).toBe(1);
    });

    it('records an override whose previous_value is derived from real lineage', async () => {
      const [rec] = await admin(
        `SELECT id FROM central_needs_source_records WHERE import_session_id=$1 AND record_ordinal=1`, [sessionA]);
      const r = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3) AS result',
        [rec.id, JSON.stringify({ normalized: 150 }), 'corrected against the signed annexe']);
      expect(r.previous_value).toEqual({ raw: '120', normalized: 120 });
      expect(r.final_value).toEqual({ normalized: 150 });
      expect(r.record_ordinal).toBe(1);
    });

    it('submits and approves the revision', async () => {
      const s = await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [revA]);
      expect(s.status).toBe('submitted');
      const a = await call(U_APPROVE_A, 'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [revA]);
      expect(a.status).toBe('approved');
      const [row] = await admin(
        `SELECT approved_by, approved_at FROM central_needs_plan_revisions WHERE id=$1`, [revA]);
      expect(row.approved_by).toBe(U_APPROVE_A);
      expect(row.approved_at).not.toBeNull();
    });
  });

  // ==========================================================================
  // J. REVIEW REPAIRS — the six blockers
  // ==========================================================================
  describe('J1. archived organization cannot be bypassed by the trusted path', () => {
    it('an organization archived BETWEEN session start and replay refuses the replay', async () => {
      // Start while live.
      const r = await openRevision(U_ALL_LATE, ORG_LATE, 2060);
      const recs = makeRecords(H('1'));
      const d = await expectedDigest(recs);
      const s = await startImport(U_ALL_LATE, r.plan_revision_id, H('1'), d);

      // Archive through M202's legal path.
      await admin(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG_LATE]);
      const [{ archived_at }] = await admin(`SELECT archived_at FROM organizations WHERE id=$1`, [ORG_LATE]);
      expect(archived_at).not.toBeNull();

      const auditBefore = (await admin(
        `SELECT count(*)::int AS c FROM audit_logs WHERE entity_id=$1`, [s.import_session_id]))[0].c;

      await expect(probeReplayAs('service_role', null, s.import_session_id, H('1'), recs))
        .rejects.toThrow(/central_needs_write_blocked_by_archived_organization/);

      // ZERO source rows and ZERO new audit rows.
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id=$1`, [s.import_session_id]);
      expect(count).toBe(0);
      const auditAfter = (await admin(
        `SELECT count(*)::int AS c FROM audit_logs WHERE entity_id=$1`, [s.import_session_id]))[0].c;
      expect(auditAfter).toBe(auditBefore);
      const [row] = await admin(
        `SELECT status FROM central_needs_import_sessions WHERE id=$1`, [s.import_session_id]);
      expect(row.status).toBe('processing');
    });
  });

  describe('J2. source identity survives real workbook shapes', () => {
    it('two same-header fields in one logical row are BOTH persisted losslessly', async () => {
      const fh = H('2');
      const dup = [
        {
          targetEntity: 'sheet:0:row:9', fieldName: 'quantity',
          sourceValues: { raw: '10' },
          sourceProvenance: { fileFingerprintSha256: fh, sheetIndex: 0, coordinate: { row: 8, col: 1, a1: 'B9' } },
        },
        {
          // SAME entity, SAME header text, different column — legal in a real
          // workbook, unrepresentable under M209's uniqueness.
          targetEntity: 'sheet:0:row:9', fieldName: 'quantity',
          sourceValues: { raw: '25' },
          sourceProvenance: { fileFingerprintSha256: fh, sheetIndex: 0, coordinate: { row: 8, col: 4, a1: 'E9' } },
        },
      ];
      const r = await openRevision(U_ALL_A, ORG_A, 2061);
      const d = await expectedDigest(dup);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, d);
      const applied = await applyReplay(s.import_session_id, fh, dup);

      expect(applied.records_inserted).toBe(2);
      const rows = await admin(
        `SELECT record_ordinal, source_values FROM central_needs_source_records
          WHERE import_session_id=$1 ORDER BY record_ordinal`, [s.import_session_id]);
      expect(rows).toHaveLength(2);
      expect(rows.map((x: any) => x.source_values.raw)).toEqual(['10', '25']);
    });

    it('two files under one revision both containing sheet:0:row:1 stay independently addressable', async () => {
      const rev = (await openRevision(U_ALL_A, ORG_A, 2062)).plan_revision_id;
      const mk = (fh: string, qty: string) => ([{
        targetEntity: 'sheet:0:row:1', fieldName: 'quantity',
        sourceValues: { raw: qty },
        sourceProvenance: { fileFingerprintSha256: fh, sheetIndex: 0, coordinate: { row: 0, col: 1, a1: 'B1' } },
      }]);

      const f1 = H('3'); const r1 = mk(f1, '111');
      const s1 = await startImport(U_ALL_A, rev, f1, await expectedDigest(r1), 'file-one.xls');
      await applyReplay(s1.import_session_id, f1, r1);

      const f2 = H('4'); const r2 = mk(f2, '222');
      const s2 = await startImport(U_ALL_A, rev, f2, await expectedDigest(r2), 'file-two.xls');
      await applyReplay(s2.import_session_id, f2, r2);

      expect(s1.import_session_id).not.toBe(s2.import_session_id);
      const rows = await admin(
        `SELECT import_session_id, source_values FROM central_needs_source_records
          WHERE import_session_id = ANY($1) ORDER BY source_values->>'raw'`,
        [[s1.import_session_id, s2.import_session_id]]);
      expect(rows).toHaveLength(2);
      expect(rows.map((x: any) => x.source_values.raw)).toEqual(['111', '222']);

      // ...and each maps independently, with no unique collision.
      const m1 = await call(U_ALL_A, 'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result',
        [s1.import_session_id, 'sheet:0:row:1', ITEM_1]);
      const m2 = await call(U_ALL_A, 'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result',
        [s2.import_session_id, 'sheet:0:row:1', ITEM_2]);
      expect(m1.central_item_id).toBe(ITEM_1);
      expect(m2.central_item_id).toBe(ITEM_2);
      expect(m1.mapping_id).not.toBe(m2.mapping_id);
    });
  });

  describe('J3. mapping and override require real lineage', () => {
    it('mapping a target_entity absent from the session is denied', async () => {
      const { session } = await importedSession(ORG_A, U_ALL_A, 2063, H('5'));
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3)',
        [session, 'sheet:99:row:999', ITEM_1])).rejects.toThrow(/target_entity_not_in_import_session/);
    });

    it('overriding a nonexistent source record is denied', async () => {
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3)',
        ['00000000-0000-0000-0000-0000009999ff', JSON.stringify({ x: 1 }), 'why']))
        .rejects.toThrow(/source_record_not_found/);
    });

    it('the override row carries its exact source lineage, and audit records it', async () => {
      const { session } = await importedSession(ORG_A, U_ALL_A, 2064, H('6'));
      const [rec] = await admin(
        `SELECT id, record_ordinal FROM central_needs_source_records
          WHERE import_session_id=$1 AND record_ordinal=1`, [session]);
      const r = await call(U_ALL_A, 'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3) AS result',
        [rec.id, JSON.stringify({ normalized: 7 }), 'lineage check']);
      const [row] = await admin(
        `SELECT source_record_id, previous_value FROM central_needs_field_overrides WHERE id=$1`, [r.override_id]);
      expect(row.source_record_id).toBe(rec.id);
      expect(row.previous_value).toEqual({ raw: '120', normalized: 120 });
      const [a] = await admin(
        `SELECT payload FROM audit_logs WHERE entity_id=$1 AND action='central_needs.field_override.record'`,
        [r.override_id]);
      expect(a.payload.source_record_id).toBe(rec.id);
      expect(a.payload.import_session_id).toBe(session);
      expect(a.payload.record_ordinal).toBe(1);
    });
  });

  describe('J4. the digest binds provenance', () => {
    it('identical values with DIFFERENT provenance fail semantic agreement', async () => {
      const fh = H('7');
      const base = makeRecords(fh);
      const r = await openRevision(U_ALL_A, ORG_A, 2065);
      const d = await expectedDigest(base);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, d);

      // Same sourceValues, different coordinate/sheet — a different import.
      const moved = JSON.parse(JSON.stringify(base));
      moved[0].sourceProvenance.coordinate = { row: 40, col: 2, a1: 'C41' };
      moved[0].sourceProvenance.sheetName = 'Other';

      await expect(probeReplayAs('service_role', null, s.import_session_id, fh, moved))
        .rejects.toThrow(/authoritative_replay_semantic_mismatch/);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id=$1`, [s.import_session_id]);
      expect(count).toBe(0);
    });

    it('extractedAt is the only normalized field — differing timestamps still agree', async () => {
      const fh = H('8');
      const preview = makeRecords(fh);
      const r = await openRevision(U_ALL_A, ORG_A, 2066);
      const d = await expectedDigest(preview);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, d);
      // The Node pass ran later: same evidence, different extractedAt.
      const node = JSON.parse(JSON.stringify(preview));
      node.forEach((x: any) => { x.sourceProvenance.extractedAt = '2099-01-01T00:00:00.000Z'; });
      const ok = await applyReplay(s.import_session_id, fh, node);
      expect(ok.status).toBe('completed');
    });

    it('a record without provenance is refused', async () => {
      const fh = H('9');
      const r = await openRevision(U_ALL_A, ORG_A, 2067);
      const bare = [{ targetEntity: 'sheet:0:row:1', fieldName: 'q', sourceValues: { raw: '1' } }];
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, H('e'));
      await expect(probeReplayAs('service_role', null, s.import_session_id, fh, bare))
        .rejects.toThrow(/record_requires_source_provenance_object/);
    });

    it('provenance naming a different file is refused', async () => {
      const fh = H('b');
      const r = await openRevision(U_ALL_A, ORG_A, 2068);
      const wrong = makeRecords(H('c')); // fingerprints a DIFFERENT file
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, await expectedDigest(wrong));
      await expect(probeReplayAs('service_role', null, s.import_session_id, fh, wrong))
        .rejects.toThrow(/record_provenance_file_fingerprint_mismatch/);
    });
  });

  describe('J5. trusted replay is idempotent on exact retry', () => {
    it('an exact retry after a lost response is a no-op', async () => {
      const fh = H('a');
      const before = await admin(
        `SELECT count(*)::int AS c FROM central_needs_source_records WHERE import_session_id=$1`, [sessionA]);
      const auditBefore = (await admin(
        `SELECT count(*)::int AS c FROM audit_logs WHERE entity_id=$1`, [sessionA]))[0].c;

      const retry = await applyReplay(sessionA, fh, recordsA);
      expect(retry.idempotent_replay).toBe(true);
      expect(retry.records_inserted).toBe(0);
      expect(retry.status).toBe('completed');

      const after = await admin(
        `SELECT count(*)::int AS c FROM central_needs_source_records WHERE import_session_id=$1`, [sessionA]);
      expect(after[0].c).toBe(before[0].c);
      const auditAfter = (await admin(
        `SELECT count(*)::int AS c FROM audit_logs WHERE entity_id=$1`, [sessionA]))[0].c;
      expect(auditAfter).toBe(auditBefore);
    });

    it('a retry carrying DIFFERENT evidence fails closed', async () => {
      const changed = makeRecords(H('a'), '999');
      await expect(probeReplayAs('service_role', null, sessionA, H('a'), changed))
        .rejects.toThrow(/import_session_already_finalized_with_different_evidence|authoritative_replay_semantic_mismatch/);
    });

    it('a retry naming a different source file fails closed', async () => {
      await expect(probeReplayAs('service_role', null, sessionA, H('f'), recordsA))
        .rejects.toThrow(/authoritative_replay_source_file_mismatch/);
    });
  });

  describe('J5b. a completed session refuses every non-exact retry', () => {
    // A dedicated finished session so these probes cannot disturb others.
    let sess = '';
    let fh = '';
    let recs: any[] = [];
    let digest = '';

    /** Snapshot the invariants every rejected retry must leave untouched. */
    const snapshot = async () => {
      const [s] = await admin(
        `SELECT status, authoritative_digest FROM central_needs_import_sessions WHERE id=$1`, [sess]);
      const [{ recCount }] = await admin(
        `SELECT count(*)::int AS "recCount" FROM central_needs_source_records WHERE import_session_id=$1`, [sess]);
      const [{ auditCount }] = await admin(
        `SELECT count(*)::int AS "auditCount" FROM audit_logs WHERE entity_id=$1`, [sess]);
      return { status: s.status, digest: s.authoritative_digest, recCount, auditCount };
    };

    /** Assert a retry is rejected AND changed nothing at all. */
    const rejects = async (payload: unknown[], pattern: RegExp, hash = fh) => {
      const before = await snapshot();
      await expect(probeReplayAs('service_role', null, sess, hash, payload)).rejects.toThrow(pattern);
      const after = await snapshot();
      expect(after.status, 'session must stay completed').toBe('completed');
      expect(after.digest, 'authoritative_digest must be unchanged').toBe(before.digest);
      expect(after.recCount, 'source_records count must be unchanged').toBe(before.recCount);
      expect(after.auditCount, 'audit count must be unchanged').toBe(before.auditCount);
    };

    beforeAll(async () => {
      fh = H('e');
      const r = await openRevision(U_ALL_A, ORG_A, 2080);
      recs = makeRecords(fh);
      digest = await expectedDigest(recs);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, digest);
      sess = s.import_session_id;
      const done = await applyReplay(sess, fh, recs);
      expect(done.status).toBe('completed');
    });

    it('1. the exact original payload is idempotent', async () => {
      const before = await snapshot();
      const retry = await applyReplay(sess, fh, recs);
      expect(retry.idempotent_replay).toBe(true);
      expect(retry.records_inserted).toBe(0);
      const after = await snapshot();
      expect(after.recCount).toBe(before.recCount);
      expect(after.auditCount).toBe(before.auditCount);
      expect(after.digest).toBe(before.digest);
    });

    it('2. a changed valid value is refused', async () => {
      const changed = JSON.parse(JSON.stringify(recs));
      changed[0].sourceValues = { raw: '999', normalized: 999 };
      await rejects(changed, /already_finalized_with_different_evidence/);
    });

    it('3. an appended empty object is refused (the string_agg NULL-drop hole)', async () => {
      await rejects([...JSON.parse(JSON.stringify(recs)), {}],
        /record_requires_target_entity_field_name_and_source_values/);
    });

    it('4. an appended object missing fieldName is refused', async () => {
      await rejects([...JSON.parse(JSON.stringify(recs)), {
        targetEntity: 'sheet:0:row:9', sourceValues: { raw: '1' },
        sourceProvenance: { fileFingerprintSha256: fh },
      }], /record_requires_target_entity_field_name_and_source_values/);
    });

    it('5. an appended object missing sourceProvenance is refused', async () => {
      await rejects([...JSON.parse(JSON.stringify(recs)), {
        targetEntity: 'sheet:0:row:9', fieldName: 'quantity', sourceValues: { raw: '1' },
      }], /record_requires_source_provenance_object/);
    });

    it('6. an appended object with the wrong file fingerprint is refused', async () => {
      await rejects([...JSON.parse(JSON.stringify(recs)), {
        targetEntity: 'sheet:0:row:9', fieldName: 'quantity', sourceValues: { raw: '1' },
        sourceProvenance: { fileFingerprintSha256: H('f') },
      }], /record_provenance_file_fingerprint_mismatch/);
    });

    it('7. a reordered but otherwise identical payload is refused — ordinal is identity', async () => {
      const reordered = JSON.parse(JSON.stringify(recs)).reverse();
      await rejects(reordered, /already_finalized_with_different_evidence/);
    });
  });

  describe('J6. a rejected revision does not dead-end the plan year', () => {
    it('reject -> open next -> import -> submit -> approve, with revision 1 left rejected', async () => {
      const year = 2070;
      const fh1 = H('1');
      const r1 = await openRevision(U_ALL_A, ORG_A, year);
      const recs1 = makeRecords(fh1);
      const s1 = await startImport(U_ALL_A, r1.plan_revision_id, fh1, await expectedDigest(recs1));
      await applyReplay(s1.import_session_id, fh1, recs1);
      await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [r1.plan_revision_id]);
      const rej = await call(U_APPROVE_A,
        'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result',
        [r1.plan_revision_id, 'quantities disagree with the annexe']);
      expect(rej.status).toBe('rejected');

      // Without the repair this was a permanent dead end.
      const r2 = await openRevision(U_ALL_A, ORG_A, year, true);
      expect(r2.revision_number).toBe(2);
      expect(r2.status).toBe('draft');
      expect(r2.previous_revision_closed_as).toBe('rejected');

      // Revision 1 stays rejected — NOT rewritten to superseded or approved.
      const [old] = await admin(
        `SELECT status, approved_by FROM central_needs_plan_revisions WHERE id=$1`, [r1.plan_revision_id]);
      expect(old.status).toBe('rejected');
      expect(old.approved_by).toBeNull();

      // The corrected revision completes the cycle.
      const fh2 = H('2');
      const recs2 = makeRecords(fh2, '130');
      const s2 = await startImport(U_ALL_A, r2.plan_revision_id, fh2, await expectedDigest(recs2));
      await applyReplay(s2.import_session_id, fh2, recs2);
      await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [r2.plan_revision_id]);
      const ok = await call(U_APPROVE_A,
        'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [r2.plan_revision_id]);
      expect(ok.status).toBe('approved');
    });

    it('a revision still under review cannot be closed out from under the reviewer', async () => {
      const fh = H('3');
      const r = await openRevision(U_ALL_A, ORG_A, 2071);
      const recs = makeRecords(fh);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, await expectedDigest(recs));
      await applyReplay(s.import_session_id, fh, recs);
      await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [r.plan_revision_id]);
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3)',
        [ORG_A, 2071, true])).rejects.toThrow(/plan_revision_still_in_review/);
    });

    it('an approved revision is superseded and keeps its approval record', async () => {
      const before = (await admin(
        `SELECT approved_by, approved_at FROM central_needs_plan_revisions WHERE id=$1`, [revA]))[0];
      const r2 = await openRevision(U_ALL_A, ORG_A, 2028, true);
      expect(r2.revision_number).toBe(2);
      expect(r2.previous_revision_closed_as).toBe('approved');
      const after = (await admin(
        `SELECT status, approved_by, approved_at FROM central_needs_plan_revisions WHERE id=$1`, [revA]))[0];
      expect(after.status).toBe('superseded');
      expect(after.approved_by).toBe(before.approved_by);
      expect(after.approved_at).toEqual(before.approved_at);
    });
  });

  // ==========================================================================
  // E. Trust boundary
  // ==========================================================================
  describe('E. an authenticated import holder cannot manufacture evidence', () => {
    let session = '';
    let digest = '';
    let recs: unknown[] = [];

    beforeAll(async () => {
      const fh = H('4');
      const r = await openRevision(U_ALL_A, ORG_A, 2041);
      recs = makeRecords(fh);
      digest = await expectedDigest(recs);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, digest);
      session = s.import_session_id;
    });

    it('cannot directly write authoritative_digest or complete a session', async () => {
      await expect(probe(U_ALL_A,
        `UPDATE central_needs_import_sessions SET authoritative_digest=$2 WHERE id=$1`, [session, BOGUS_DIGEST]))
        .rejects.toThrow(/permission denied/i);
      await expect(probe(U_IMPORT_A,
        `UPDATE central_needs_import_sessions SET status='completed' WHERE id=$1`, [session]))
        .rejects.toThrow(/permission denied/i);
    });

    it('cannot call the trusted replay RPC even holding central_needs.import', async () => {
      await expect(probeReplayAs('authenticated', U_ALL_A, session, H('4'), recs))
        .rejects.toThrow(/permission denied for function/i);
      await expect(probeReplayAs('authenticated', U_IMPORT_A, session, H('4'), recs))
        .rejects.toThrow(/permission denied for function/i);
    });

    it('claiming runtime="node" and a matching digest are both insufficient', async () => {
      const [pre] = await admin(`SELECT preview_digest FROM central_needs_import_sessions WHERE id=$1`, [session]);
      expect(pre.preview_digest).toBe(digest); // the client knows the real digest
      await expect(probeReplayAs('authenticated', U_ALL_A, session, H('4'), recs, NODE_IDENTITY))
        .rejects.toThrow(/permission denied for function/i);
      const [row] = await admin(`SELECT status FROM central_needs_import_sessions WHERE id=$1`, [session]);
      expect(row.status).toBe('processing');
    });

    it('cannot persist forged immutable evidence by any client route', async () => {
      await expect(probe(U_ALL_A,
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
         VALUES ($1,$2,99,'forged','quantity','{"raw":"999999"}'::jsonb)`, [session, ORG_A]))
        .rejects.toThrow(/permission denied/i);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN
            ('phoenix_central_needs_record_source_values','phoenix_central_needs_finalize_import_session')`);
      expect(count).toBe(0);
    });

    it('a browser-runtime impostor is refused even from service_role', async () => {
      await expect(probeReplayAs('service_role', null, session, H('4'), recs, BROWSER_IDENTITY))
        .rejects.toThrow(/authoritative_pass_must_be_node_runtime/);
    });

    it('an empty replay cannot finalize', async () => {
      await expect(probeReplayAs('service_role', null, session, H('4'), []))
        .rejects.toThrow(/authoritative_replay_produced_no_records/);
    });

    it('the declarative CHECK blocks a forged completion even for a superuser', async () => {
      await expect(admin(
        `UPDATE central_needs_import_sessions SET status='completed', completed_at=now(), authoritative_digest=$2
          WHERE id=$1`, [session, BOGUS_DIGEST]))
        .rejects.toThrow(/central_needs_import_sessions_authoritative_finalization_chk/);
    });

    it('the trusted backend CAN complete it', async () => {
      const ok = await applyReplay(session, H('4'), recs);
      expect(ok.status).toBe('completed');
      expect(ok.authoritative_digest).toBe(digest);
    });

    it('submit still requires a genuinely trusted import', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2053);
      await startImport(U_ALL_A, r.plan_revision_id, H('5'), await expectedDigest(makeRecords(H('5'))));
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1)', [r.plan_revision_id]))
        .rejects.toThrow(/plan_revision_has_no_finalized_import/);
    });
  });

  // ==========================================================================
  // A/B/C. Authentication, permission, organization
  // ==========================================================================
  describe('A. authentication', () => {
    it('refuses unauthenticated, anon and profile-less callers', async () => {
      await expect(probe(null, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/not_authenticated/);
      await expect(probe(null, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031], 'anon'))
        .rejects.toThrow(/permission denied|not_authenticated/i);
      await expect(probe(U_GHOST, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/forbidden_central_needs/);
      await expect(probeReplayAs('anon', null, sessionA, H('a'), recordsA))
        .rejects.toThrow(/permission denied for function/i);
    });
  });

  describe('B. permission', () => {
    it('refuses a same-org user holding no central_needs key', async () => {
      await expect(probe(U_NONE_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses institution_admin — no role gets an accidental grant', async () => {
      await expect(probe(U_INST_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/forbidden_central_needs/);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM role_permission_defaults WHERE permission_key LIKE 'central_needs.%'`);
      expect(count).toBe(0);
    });

    it('refuses import-only on an edit-gated RPC and edit-only on an import-gated RPC', async () => {
      await expect(probe(U_IMPORT_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2032]))
        .rejects.toThrow(/forbidden_central_needs/);
      const r = await openRevision(U_EDIT_A, ORG_A, 2033);
      await expect(probe(U_EDIT_A, 'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5)',
        [r.plan_revision_id, 'x.xls', H('a'), digestA, JSON.stringify(BROWSER_IDENTITY)]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses approval AND rejection to a user holding only central_needs.edit', async () => {
      const fh = H('6');
      const r = await openRevision(U_ALL_A, ORG_A, 2034);
      const recs = makeRecords(fh);
      const s = await startImport(U_ALL_A, r.plan_revision_id, fh, await expectedDigest(recs));
      await applyReplay(s.import_session_id, fh, recs);
      await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [r.plan_revision_id]);

      await expect(probe(U_EDIT_A, 'SELECT public.phoenix_central_needs_approve_revision($1)', [r.plan_revision_id]))
        .rejects.toThrow(/forbidden_central_needs/);
      await expect(probe(U_EDIT_A, 'SELECT public.phoenix_central_needs_reject_revision($1,$2)',
        [r.plan_revision_id, 'no'])).rejects.toThrow(/forbidden_central_needs/);

      const ok = await call(U_APPROVE_A,
        'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [r.plan_revision_id]);
      expect(ok.status).toBe('approved');
    });
  });

  describe('C. organization boundary', () => {
    it('refuses cross-organization mutation even with every key in the other org', async () => {
      await expect(probe(U_ALL_B, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2035]))
        .rejects.toThrow(/forbidden_central_needs/);
      await expect(probe(U_ALL_B, 'SELECT public.phoenix_central_needs_submit_revision($1)', [revA]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses a nonexistent organization', async () => {
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_ABSENT, 2036]))
        .rejects.toThrow(/organization_not_found/);
    });

    it('refuses every client mutation under an archived organization', async () => {
      await expect(probe(U_ALL_ARCH, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)',
        [ORG_ARCHIVED, 2037])).rejects.toThrow(/central_needs_write_blocked_by_archived_organization/);
    });
  });

  // ==========================================================================
  // D. Illegal transitions
  // ==========================================================================
  describe('D. illegal transitions fail closed', () => {
    it('refuses to mutate content on a closed revision', async () => {
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3)',
        [sessionA, 'sheet:0:row:5', ITEM_1])).rejects.toThrow(/plan_revision_not_editable/);
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5)',
        [revA, 'late.xls', H('c'), digestA, JSON.stringify(BROWSER_IDENTITY)]))
        .rejects.toThrow(/plan_revision_not_editable/);
    });

    it('refuses to approve a revision that was never submitted', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2038);
      await expect(probe(U_APPROVE_A, 'SELECT public.phoenix_central_needs_approve_revision($1)',
        [r.plan_revision_id])).rejects.toThrow(/plan_revision_not_submitted/);
    });

    it('refuses to open a new revision over a closed one without the explicit flag', async () => {
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2070]))
        .rejects.toThrow(/plan_revision_already_closed/);
    });
  });

  // ==========================================================================
  // F. Source immutability
  // ==========================================================================
  describe('F. source evidence stays immutable', () => {
    it('refuses to update a source record or source file even as superuser', async () => {
      await expect(admin(
        `UPDATE central_needs_source_records SET source_values='{"tampered":true}'::jsonb
          WHERE import_session_id=$1`, [sessionA])).rejects.toThrow(/central_needs_source_file_immutable/);
      await expect(admin(
        `UPDATE central_needs_source_files SET original_filename='other.xls' WHERE plan_revision_id=$1`, [revA]))
        .rejects.toThrow(/central_needs_source_file_immutable/);
    });

    it('an override leaves the source evidence byte-identical', async () => {
      const { session } = await importedSession(ORG_A, U_ALL_A, 2072, H('7'));
      const [rec] = await admin(
        `SELECT id, source_values, source_provenance FROM central_needs_source_records
          WHERE import_session_id=$1 AND record_ordinal=1`, [session]);
      await call(U_ALL_A, 'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3) AS result',
        [rec.id, JSON.stringify({ normalized: 200 }), 'second correction']);
      const [after] = await admin(
        `SELECT source_values, source_provenance FROM central_needs_source_records WHERE id=$1`, [rec.id]);
      expect(after.source_values).toEqual(rec.source_values);
      expect(after.source_provenance).toEqual(rec.source_provenance);
    });

    it('requires a reason for every override', async () => {
      const { session } = await importedSession(ORG_A, U_ALL_A, 2073, H('8'));
      const [rec] = await admin(
        `SELECT id FROM central_needs_source_records WHERE import_session_id=$1 AND record_ordinal=1`, [session]);
      for (const bad of [null, '', '   ']) {
        await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3)',
          [rec.id, JSON.stringify({ normalized: 1 }), bad])).rejects.toThrow(/override_reason_required/);
      }
    });

    it('a second override chains from the first, not from the source', async () => {
      const { session } = await importedSession(ORG_A, U_ALL_A, 2074, H('9'));
      const [rec] = await admin(
        `SELECT id FROM central_needs_source_records WHERE import_session_id=$1 AND record_ordinal=1`, [session]);
      const first = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3) AS result',
        [rec.id, JSON.stringify({ normalized: 300 }), 'first']);
      expect(first.previous_value).toEqual({ raw: '120', normalized: 120 });
      const second = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3) AS result',
        [rec.id, JSON.stringify({ normalized: 400 }), 'second']);
      expect(second.previous_value).toEqual({ normalized: 300 });
    });
  });

  // ==========================================================================
  // G. Audit
  // ==========================================================================
  describe('G. audit', () => {
    it('attributes a client mutation to the acting profile', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2043);
      const rows = await admin(
        `SELECT organization_id, actor_id, actor_role, entity_type, payload FROM audit_logs
          WHERE entity_id=$1 AND action='central_needs.plan_revision.open'`, [r.plan_revision_id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(ORG_A);
      expect(rows[0].actor_id).toBe(U_ALL_A);
      expect(rows[0].actor_role).toBe('central_warehouse_manager');
      expect(rows[0].payload.plan_year).toBe(2043);
    });

    it('attributes the trusted replay to service_role, not a client actor', async () => {
      const rows = await admin(
        `SELECT actor_id, actor_role, payload FROM audit_logs
          WHERE action='central_needs.import_session.authoritative_replay' AND entity_id=$1`, [sessionA]);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBeNull();
      expect(rows[0].actor_role).toBe('service_role');
      expect(rows[0].payload.authoritative_digest).toBe(digestA);
    });

    it('covers every workflow mutation with its own action name', async () => {
      const rows = await admin(
        `SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'central_needs.%' ORDER BY action`);
      expect(rows.map((r: any) => r.action)).toEqual([
        'central_needs.field_override.record',
        'central_needs.import_session.authoritative_replay',
        'central_needs.import_session.start',
        'central_needs.plan_revision.approve',
        'central_needs.plan_revision.open',
        'central_needs.plan_revision.reject',
        'central_needs.plan_revision.submit',
        'central_needs.record_mapping.set',
      ]);
    });

    it('a denied mutation leaves no audit row at all', async () => {
      const before = (await admin(`SELECT count(*)::int AS c FROM audit_logs WHERE action LIKE 'central_needs.%'`))[0].c;
      await expect(probe(U_NONE_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2044]))
        .rejects.toThrow(/forbidden_central_needs/);
      await expect(probe(U_ALL_B, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2045]))
        .rejects.toThrow(/forbidden_central_needs/);
      const after = (await admin(`SELECT count(*)::int AS c FROM audit_logs WHERE action LIKE 'central_needs.%'`))[0].c;
      expect(after).toBe(before);
    });

    it('a rolled-back mutation leaves no orphan audit row', async () => {
      let created = '';
      await rig.asUser(U_ALL_A, async (c: any) => {
        const res = await c.query(
          'SELECT public.phoenix_central_needs_open_plan_revision($1,$2) AS result', [ORG_A, 2046]);
        created = res.rows[0].result.plan_revision_id;
        // Not asserting audit visibility from inside: `authenticated` cannot
        // read audit_logs, so a count here would read 0 for RLS reasons.
      }); // ROLLBACK
      expect(created).not.toBe('');
      const [{ c }] = await admin(`SELECT count(*)::int AS c FROM audit_logs WHERE entity_id=$1`, [created]);
      expect(c).toBe(0);
    });

    it('never copies imported business values into the audit payload', async () => {
      const rows = await admin(
        `SELECT payload FROM audit_logs WHERE action='central_needs.import_session.authoritative_replay'`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(JSON.stringify(r.payload)).not.toContain('Paracetamol');
        expect(r.payload).toHaveProperty('records_inserted');
      }
    });
  });

  // ==========================================================================
  // H. Privilege surface — full ACL catalog
  // ==========================================================================
  describe('H. privilege surface', () => {
    const acl = async (sig: string) => {
      const [row] = await admin(
        `SELECT
           EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure($1)))
                    WHERE grantee = 0 AND privilege_type='EXECUTE') AS pub,
           has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') AS anon,
           has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') AS auth,
           has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') AS svc,
           (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure($1)) AS secdef,
           (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure($1)) AS cfg`, [sig]);
      return row;
    };

    it('client RPCs: PUBLIC no, anon no, authenticated YES, service_role yes', async () => {
      for (const sig of CLIENT_RPCS) {
        const r = await acl(sig);
        expect(r.pub, `PUBLIC on ${sig}`).toBe(false);
        expect(r.anon, `anon on ${sig}`).toBe(false);
        expect(r.auth, `authenticated on ${sig}`).toBe(true);
        expect(r.secdef, `SECURITY DEFINER on ${sig}`).toBe(true);
        expect(r.cfg, `search_path on ${sig}`).toContain('search_path=public, pg_temp');
      }
    });

    it('the TRUSTED replay RPC: PUBLIC no, anon no, authenticated NO, service_role YES', async () => {
      const r = await acl(TRUSTED_RPC);
      expect(r.pub).toBe(false);
      expect(r.anon).toBe(false);
      expect(r.auth, 'authenticated must NOT reach the trusted replay').toBe(false);
      expect(r.svc, 'service_role must reach the trusted replay').toBe(true);
      expect(r.secdef).toBe(true);
      expect(r.cfg).toContain('search_path=public, pg_temp');
    });

    it('internal helpers: unreachable by PUBLIC, anon and authenticated', async () => {
      for (const sig of INTERNAL_HELPERS) {
        const r = await acl(sig);
        expect(r.pub, `PUBLIC on ${sig}`).toBe(false);
        expect(r.anon, `anon on ${sig}`).toBe(false);
        expect(r.auth, `authenticated on ${sig}`).toBe(false);
      }
    });

    it('grants no client a direct write on any Central Needs table', async () => {
      for (const t of CENTRAL_NEEDS_TABLES) {
        for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
          const [row] = await admin(
            `SELECT has_table_privilege('authenticated', $1, $2) AS a,
                    has_table_privilege('anon', $1, $2) AS n`, [`public.${t}`, priv]);
          expect(row.a, `authenticated ${priv} ${t}`).toBe(false);
          expect(row.n, `anon ${priv} ${t}`).toBe(false);
        }
      }
    });

    it('adds no unexpected grantee to the new table', async () => {
      const [row] = await admin(
        `SELECT coalesce(array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text), '{}') AS grantees
           FROM aclexplode((SELECT relacl FROM pg_class WHERE oid='public.central_needs_record_mappings'::regclass))`);
      for (const g of row.grantees) {
        expect(['postgres', 'authenticated', 'service_role', 'supabase_admin', '-'], `grantee ${g}`).toContain(g);
      }
      expect(row.grantees).not.toContain('anon');
    });
  });

  // ==========================================================================
  // I. Movement negative proof
  // ==========================================================================
  describe('I. CN-1B moves no stock and creates no transfer', () => {
    it('leaves every stock and transfer surface untouched', async () => {
      for (const t of ['warehouse_stock', 'inventory_transfer_suggestions',
        'warehouse_transfer_requests', 'warehouse_stock_movements']) {
        const [{ exists }] = await admin(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t}`]);
        if (!exists) continue;
        const [{ count }] = await admin(`SELECT count(*)::int FROM public.${t}`);
        expect(count, `${t} must remain empty`).toBe(0);
      }
    });

    it('defines no Central Needs send permission anywhere', async () => {
      const [{ count }] = await admin(`SELECT count(*)::int FROM permission_keys WHERE key = 'central_needs.send'`);
      expect(count).toBe(0);
      const [{ c2 }] = await admin(
        `SELECT count(*)::int AS c2 FROM permission_keys WHERE module='central_needs'`);
      expect(c2).toBe(4);
    });

    it('no CN-1B function references a transfer, movement or send surface', async () => {
      const rows = await admin(
        `SELECT p.proname, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname LIKE '%central_needs%'`);
      const cn1b = rows.filter((r: any) => r.proname !== '_phoenix_central_needs_source_immutability_v1');
      expect(cn1b.length).toBe(CLIENT_RPCS.length + 1 + INTERNAL_HELPERS.length);
      for (const r of cn1b) {
        for (const forbidden of ['warehouse_stock', 'inventory_transfer_suggestions',
          'warehouse_transfer', 'stock_movements', 'central_needs.send']) {
          expect(r.def, `${r.proname} must not reference ${forbidden}`).not.toContain(forbidden);
        }
      }
    });
  });
});
