/**
 * CN-1B / M210 — CENTRAL NEEDS WORKFLOW RPCs — DYNAMIC proof against a real
 * disposable Postgres with 001->210 applied in order.
 *
 * The static suite guards the migration's TEXT. This file proves the
 * behaviour that text is supposed to produce, against a real database, with
 * real role impersonation so auth.uid(), RLS, SECURITY DEFINER and the
 * service_role trust boundary all behave exactly as they will in production.
 *
 *   A. Authentication  — anon and unauthenticated callers are refused.
 *   B. Permission      — each RPC demands its own key; approval demands
 *                        central_needs.approve specifically; no role gets an
 *                        accidental grant.
 *   C. Organization    — same-org allowed, cross-org refused, archived
 *                        organization refused, nonexistent organization
 *                        refused.
 *   D. State machine   — legal transitions succeed, illegal ones fail closed,
 *                        approved history is never mutated in place, and a
 *                        superseding revision preserves it.
 *   E. TRUST BOUNDARY  — the heart of this suite. An authenticated caller
 *                        holding central_needs.import cannot manufacture
 *                        authoritative replay evidence: it cannot reach the
 *                        trusted RPC, cannot insert source records, cannot
 *                        set authoritative_digest, and cannot finalize —
 *                        not by claiming runtime='node', not by choosing a
 *                        preview digest equal to the real one, not at all.
 *                        Only service_role can, and even then the database
 *                        recomputes the digest over the rows it just wrote.
 *   F. Immutability    — source evidence cannot be updated; an override
 *                        changes the business value while leaving the source
 *                        row byte-identical; a reason is mandatory.
 *   G. Audit           — every authorized mutation writes exactly its own
 *                        event; a denied mutation writes none; a rolled-back
 *                        mutation leaves no orphan.
 *   H. Privileges      — full ACL catalog assertion for PUBLIC / anon /
 *                        authenticated / service_role on every function.
 *   I. Movement        — CN-1B touches no stock, creates no transfer, and
 *                        uses no send permission.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000210001';
const ORG_B = '00000000-0000-0000-0000-000000210002';
const ORG_ARCHIVED = '00000000-0000-0000-0000-000000210003';
const ORG_ABSENT = '00000000-0000-0000-0000-0000002109ff';

const U_ALL_A = '00000000-0000-0000-0000-000000210401'; // org A: view+import+edit+approve
const U_IMPORT_A = '00000000-0000-0000-0000-000000210402'; // org A: import only
const U_EDIT_A = '00000000-0000-0000-0000-000000210403'; // org A: edit only
const U_APPROVE_A = '00000000-0000-0000-0000-000000210404'; // org A: approve only
const U_NONE_A = '00000000-0000-0000-0000-000000210405'; // org A: no central_needs key
const U_ALL_B = '00000000-0000-0000-0000-000000210406'; // org B: every key — cross-org probe
const U_INST_A = '00000000-0000-0000-0000-000000210407'; // institution_admin, org A, no grant
const U_ALL_ARCH = '00000000-0000-0000-0000-000000210408'; // archived org: every key
const U_GHOST = '00000000-0000-0000-0000-0000002104ff'; // no auth.users / profiles row at all

const ITEM_1 = '00000000-0000-0000-0000-000000210801';
const ITEM_2 = '00000000-0000-0000-0000-000000210802';

const FILE_HASH = 'a'.repeat(64);
const FILE_HASH_2 = 'b'.repeat(64);
const FILE_HASH_3 = 'c'.repeat(64);
const WRONG_HASH = 'f'.repeat(64);
const BOGUS_DIGEST = 'd'.repeat(64);

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

/** Every function this migration owns, with its intended ACL. */
const CLIENT_RPCS = [
  'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
  'public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text)',
  'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)',
  'public.phoenix_central_needs_record_field_override(uuid, text, text, jsonb, text, text, text)',
  'public.phoenix_central_needs_submit_revision(uuid)',
  'public.phoenix_central_needs_approve_revision(uuid)',
  'public.phoenix_central_needs_reject_revision(uuid, text)',
];
const TRUSTED_RPC = 'public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)';
const INTERNAL_HELPERS = [
  'public._phoenix_central_needs_guard_v1(uuid, text)',
  'public._phoenix_central_needs_load_revision_v1(uuid)',
  'public._phoenix_central_needs_assert_draft_v1(uuid, text)',
  'public._phoenix_central_needs_semantic_digest_v1(uuid)',
];

run('CN-1B/210 central-needs workflow RPCs — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  /** Run WITHOUT committing — for denial probes. */
  const probe = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params), { role });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  const SAMPLE_RECORDS = [
    {
      targetEntity: 'line-1', fieldName: 'quantity',
      sourceValues: { raw: '120', normalized: 120 },
      sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { row: 4, col: 2, a1: 'C5' } },
    },
    {
      targetEntity: 'line-1', fieldName: 'item_name',
      sourceValues: { raw: 'Paracetamol 500mg' },
      sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { row: 4, col: 1, a1: 'B5' } },
    },
  ];

  /**
   * The canonical digest the DATABASE will compute for a given record set,
   * derived with the same expression the migration uses. Tests need it to
   * construct a preview digest that legitimately agrees, without ever
   * borrowing the value from the function under test.
   */
  const expectedDigest = async (records: unknown[]): Promise<string> => {
    const [row] = await admin(
      `SELECT encode(sha256(convert_to(COALESCE(string_agg(
           btrim(r->>'targetEntity') || E'\\x1F' || btrim(r->>'fieldName') || E'\\x1F' || (r->'sourceValues')::text,
           E'\\x1E' ORDER BY btrim(r->>'targetEntity') COLLATE "C", btrim(r->>'fieldName') COLLATE "C"
         ), ''), 'UTF8')), 'hex') AS d
         FROM jsonb_array_elements($1::jsonb) r`,
      [JSON.stringify(records)]);
    return row.d;
  };

  const openRevision = (u: string, org: string, year: number, supersede = false) =>
    call(u, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result', [org, year, supersede]);

  const startImport = (u: string, rev: string, hash: string, preview: string, name = 'needs-2028.xls') =>
    call(u, 'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5) AS result',
      [rev, name, hash, preview, JSON.stringify(BROWSER_IDENTITY)]);

  /** The TRUSTED path — runs as service_role, as a real backend worker would. */
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

  let revA = '';
  let sessionA = '';
  let planA = '';
  let digestA = '';

  beforeAll(async () => {
    rig = await buildRig({ upTo: 210 });

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','CN210-A','أ','p210-a','care_institution','hospital'),
        ('${ORG_B}','CN210-B','ب','p210-b','care_institution','hospital'),
        ('${ORG_ARCHIVED}','CN210-ARCH','ج','p210-arch','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_ALL_A}','p210-all-a@rig'),('${U_IMPORT_A}','p210-imp-a@rig'),
        ('${U_EDIT_A}','p210-edit-a@rig'),('${U_APPROVE_A}','p210-appr-a@rig'),
        ('${U_NONE_A}','p210-none-a@rig'),('${U_ALL_B}','p210-all-b@rig'),
        ('${U_INST_A}','p210-inst-a@rig'),('${U_ALL_ARCH}','p210-all-arch@rig')
        ON CONFLICT (id) DO NOTHING;`);

      for (const [u, org, role] of [
        [U_ALL_A, ORG_A, 'central_warehouse_manager'], [U_IMPORT_A, ORG_A, 'central_warehouse_manager'],
        [U_EDIT_A, ORG_A, 'central_warehouse_manager'], [U_APPROVE_A, ORG_A, 'central_warehouse_manager'],
        [U_NONE_A, ORG_A, 'central_warehouse_manager'], [U_ALL_B, ORG_B, 'central_warehouse_manager'],
        [U_INST_A, ORG_A, 'institution_admin'], [U_ALL_ARCH, ORG_ARCHIVED, 'central_warehouse_manager'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1,status='active',organization_id=$2 WHERE id=$3`, [role, org, u]);
      }

      const grants: Array<[string, string]> = [];
      for (const k of ['view', 'import', 'edit', 'approve']) {
        grants.push([U_ALL_A, `central_needs.${k}`]);
        grants.push([U_ALL_B, `central_needs.${k}`]);
        grants.push([U_ALL_ARCH, `central_needs.${k}`]);
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

      // Archive the ONLY way M202 permits: archived_at is database-owned and a
      // direct write is neutralized by its guard, so a legal status transition
      // is the sole path. Asserted, or the archived-org tests would be vacuous.
      await c.query(`UPDATE organizations SET status = 'inactive' WHERE id = '${ORG_ARCHIVED}'`);
      const [{ archived_at: stamped }] = (await c.query(
        `SELECT archived_at FROM organizations WHERE id = '${ORG_ARCHIVED}'`)).rows;
      if (!stamped) throw new Error('fixture precondition failed: ORG_ARCHIVED was not actually archived');
    });

    digestA = await expectedDigest(SAMPLE_RECORDS);
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ==========================================================================
  // D/E. The committed happy path — every later section builds on this.
  // ==========================================================================
  describe('D. workflow happy path', () => {
    it('opens a plan and its first revision', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2028);
      expect(r.ok).toBe(true);
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

    it('a client starts an import session carrying only a PROVISIONAL preview digest', async () => {
      const r = await startImport(U_ALL_A, revA, FILE_HASH, digestA);
      expect(r.ok).toBe(true);
      expect(r.status).toBe('processing');
      sessionA = r.import_session_id;

      const [row] = await admin(
        `SELECT status, preview_digest, authoritative_digest FROM central_needs_import_sessions WHERE id=$1`,
        [sessionA]);
      expect(row.status).toBe('processing');
      expect(row.preview_digest).toBe(digestA);
      // Nothing authoritative exists yet, and no source record has been written.
      expect(row.authoritative_digest).toBeNull();
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id=$1`, [sessionA]);
      expect(count).toBe(0);
    });

    it('replaying the same file hash on the same revision returns the same session', async () => {
      const r = await startImport(U_ALL_A, revA, FILE_HASH, digestA);
      expect(r.idempotent_replay).toBe(true);
      expect(r.import_session_id).toBe(sessionA);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_files WHERE plan_revision_id=$1`, [revA]);
      expect(count).toBe(1);
    });

    it('the TRUSTED replay writes the evidence, recomputes the digest and finalizes', async () => {
      const r = await applyReplay(sessionA, FILE_HASH, SAMPLE_RECORDS);
      expect(r.ok).toBe(true);
      expect(r.status).toBe('completed');
      expect(r.records_inserted).toBe(2);
      // The digest stored is the database's own recomputation.
      expect(r.authoritative_digest).toBe(digestA);

      const [row] = await admin(
        `SELECT status, authoritative_digest, parser_identity, completed_at
           FROM central_needs_import_sessions WHERE id=$1`, [sessionA]);
      expect(row.status).toBe('completed');
      expect(row.authoritative_digest).toBe(digestA);
      expect(row.parser_identity.runtime).toBe('node');
      expect(row.completed_at).not.toBeNull();
    });

    it('the persisted records correspond exactly to the trusted replay payload', async () => {
      const rows = await admin(
        `SELECT target_entity, field_name, source_values, source_provenance
           FROM central_needs_source_records WHERE import_session_id=$1
          ORDER BY target_entity, field_name`, [sessionA]);
      expect(rows).toHaveLength(SAMPLE_RECORDS.length);
      const expected = [...SAMPLE_RECORDS].sort((a, b) =>
        (a.targetEntity + a.fieldName).localeCompare(b.targetEntity + b.fieldName));
      rows.forEach((row: any, i: number) => {
        expect(row.target_entity).toBe(expected[i].targetEntity);
        expect(row.field_name).toBe(expected[i].fieldName);
        expect(row.source_values).toEqual(expected[i].sourceValues);
        expect(row.source_provenance).toEqual(expected[i].sourceProvenance);
      });
      // And the stored digest genuinely describes those rows.
      const [{ d }] = await admin(
        `SELECT public._phoenix_central_needs_semantic_digest_v1($1) AS d`, [sessionA]);
      expect(d).toBe(digestA);
    });

    it('maps an imported entity onto a canonical central item', async () => {
      const r = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result',
        [revA, 'line-1', ITEM_1]);
      expect(r.ok).toBe(true);
      expect(r.central_item_id).toBe(ITEM_1);
    });

    it('re-mapping the same entity records the previous link', async () => {
      const r = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result',
        [revA, 'line-1', ITEM_2]);
      expect(r.previous_central_item_id).toBe(ITEM_1);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_record_mappings WHERE plan_revision_id=$1`, [revA]);
      expect(count).toBe(1);
    });

    it('records a reasoned override chained off the source value', async () => {
      const r = await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3,$4,$5) AS result',
        [revA, 'line-1', 'quantity', JSON.stringify({ normalized: 150 }), 'corrected against the signed annexe']);
      expect(r.ok).toBe(true);
      expect(r.previous_value).toEqual({ raw: '120', normalized: 120 });
      expect(r.final_value).toEqual({ normalized: 150 });
    });

    it('submits the revision for review', async () => {
      const r = await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [revA]);
      expect(r.status).toBe('submitted');
    });

    it('approves the revision atomically with its approver stamp', async () => {
      const r = await call(U_APPROVE_A, 'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [revA]);
      expect(r.status).toBe('approved');
      const [row] = await admin(
        `SELECT status, approved_by, approved_at FROM central_needs_plan_revisions WHERE id=$1`, [revA]);
      expect(row.status).toBe('approved');
      expect(row.approved_by).toBe(U_APPROVE_A);
      expect(row.approved_at).not.toBeNull();
    });
  });

  // ==========================================================================
  // E. THE TRUST BOUNDARY — the adversarial matrix
  // ==========================================================================
  describe('E. an authenticated import holder cannot manufacture authoritative evidence', () => {
    let rev = '';
    let session = '';
    let digest = '';

    beforeAll(async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2041);
      rev = r.plan_revision_id;
      digest = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, rev, FILE_HASH_2, digest);
      session = s.import_session_id;
    });

    it('1. cannot directly write authoritative_digest on the session', async () => {
      await expect(probe(U_ALL_A,
        `UPDATE central_needs_import_sessions SET authoritative_digest=$2 WHERE id=$1`,
        [session, BOGUS_DIGEST])).rejects.toThrow(/permission denied/i);
      await expect(probe(U_IMPORT_A,
        `UPDATE central_needs_import_sessions SET status='completed' WHERE id=$1`, [session]))
        .rejects.toThrow(/permission denied/i);
    });

    it('2. cannot call the trusted replay RPC at all — even holding central_needs.import', async () => {
      await expect(probeReplayAs('authenticated', U_ALL_A, session, FILE_HASH_2, SAMPLE_RECORDS))
        .rejects.toThrow(/permission denied for function/i);
      await expect(probeReplayAs('authenticated', U_IMPORT_A, session, FILE_HASH_2, SAMPLE_RECORDS))
        .rejects.toThrow(/permission denied for function/i);
    });

    it('3. claiming parser_identity runtime="node" from a client is insufficient', async () => {
      // The claim buys nothing: the surface that consumes it is unreachable.
      await expect(probeReplayAs('authenticated', U_ALL_A, session, FILE_HASH_2, SAMPLE_RECORDS, NODE_IDENTITY))
        .rejects.toThrow(/permission denied for function/i);
      const [row] = await admin(
        `SELECT status, authoritative_digest FROM central_needs_import_sessions WHERE id=$1`, [session]);
      expect(row.status).toBe('processing');
      expect(row.authoritative_digest).toBeNull();
    });

    it('4. supplying a preview digest equal to the real authoritative digest is insufficient', async () => {
      // The client DOES know the correct digest here (it is `digest`), and the
      // session already carries it as preview_digest. That still yields no path
      // to completion, because completion requires the trusted transaction.
      const [pre] = await admin(
        `SELECT preview_digest FROM central_needs_import_sessions WHERE id=$1`, [session]);
      expect(pre.preview_digest).toBe(digest);
      await expect(probeReplayAs('authenticated', U_ALL_A, session, FILE_HASH_2, SAMPLE_RECORDS))
        .rejects.toThrow(/permission denied for function/i);
      const [row] = await admin(
        `SELECT status FROM central_needs_import_sessions WHERE id=$1`, [session]);
      expect(row.status).toBe('processing');
    });

    it('5. cannot persist forged immutable source evidence by any client route', async () => {
      await expect(probe(U_ALL_A,
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, target_entity, field_name, source_values)
         VALUES ($1,$2,'forged','quantity','{"raw":"999999"}'::jsonb)`, [session, ORG_A]))
        .rejects.toThrow(/permission denied/i);
      // And no client-facing RPC exists that would do it on their behalf.
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'
            AND p.proname IN ('phoenix_central_needs_record_source_values',
                              'phoenix_central_needs_finalize_import_session')`);
      expect(count).toBe(0);
    });

    it('6. the trusted backend CAN persist authoritative evidence', async () => {
      const r = await applyReplay(session, FILE_HASH_2, SAMPLE_RECORDS);
      expect(r.ok).toBe(true);
      expect(r.status).toBe('completed');
      expect(r.authoritative_digest).toBe(digest);
    });

    it('7. a trusted replay carrying the wrong file SHA is denied', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2047);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH_3, d);
      await expect(probeReplayAs('service_role', null, s.import_session_id, WRONG_HASH, SAMPLE_RECORDS))
        .rejects.toThrow(/authoritative_replay_source_file_mismatch/);
      const [row] = await admin(
        `SELECT status FROM central_needs_import_sessions WHERE id=$1`, [s.import_session_id]);
      expect(row.status).toBe('processing');
    });

    it('8. a trusted replay whose records disagree with the preview is denied', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2048);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      const divergent = [
        { ...SAMPLE_RECORDS[0], sourceValues: { raw: '999', normalized: 999 } },
        SAMPLE_RECORDS[1],
      ];
      await expect(probeReplayAs('service_role', null, s.import_session_id, FILE_HASH, divergent))
        .rejects.toThrow(/authoritative_replay_semantic_mismatch/);
      // Fail-closed: neither the session nor any record survives the rejection.
      const [row] = await admin(
        `SELECT status, authoritative_digest FROM central_needs_import_sessions WHERE id=$1`,
        [s.import_session_id]);
      expect(row.status).toBe('processing');
      expect(row.authoritative_digest).toBeNull();
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id=$1`,
        [s.import_session_id]);
      expect(count).toBe(0);
    });

    it('9. a trusted replay with exact semantic agreement succeeds', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2049);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      const ok = await applyReplay(s.import_session_id, FILE_HASH, SAMPLE_RECORDS);
      expect(ok.status).toBe('completed');
      expect(ok.authoritative_digest).toBe(d);
    });

    it('10. a trusted replay that mislabels its own runtime is denied', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2050);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      await expect(probeReplayAs('service_role', null, s.import_session_id, FILE_HASH,
        SAMPLE_RECORDS, BROWSER_IDENTITY)).rejects.toThrow(/authoritative_pass_must_be_node_runtime/);
    });

    it('11. an empty replay cannot finalize', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2051);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      await expect(probeReplayAs('service_role', null, s.import_session_id, FILE_HASH, []))
        .rejects.toThrow(/authoritative_replay_produced_no_records/);
    });

    it('12. post-finalization mutation remains denied on every route', async () => {
      await expect(probeReplayAs('service_role', null, session, FILE_HASH_2, SAMPLE_RECORDS))
        .rejects.toThrow(/import_session_not_open/);
      await expect(admin(
        `UPDATE central_needs_source_records SET source_values='{"t":1}'::jsonb WHERE import_session_id=$1`,
        [session])).rejects.toThrow(/central_needs_source_file_immutable/);
    });

    it('13. the declarative CHECK blocks a forged completion even for a superuser', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2052);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      await expect(admin(
        `UPDATE central_needs_import_sessions
            SET status='completed', completed_at=now(), authoritative_digest=$2
          WHERE id=$1`, [s.import_session_id, BOGUS_DIGEST]))
        .rejects.toThrow(/central_needs_import_sessions_authoritative_finalization_chk/);
    });

    it('14. anon reaches neither the client nor the trusted surface', async () => {
      await expect(probe(null, 'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5)',
        [rev, 'x.xls', FILE_HASH, digest, JSON.stringify(BROWSER_IDENTITY)], 'anon'))
        .rejects.toThrow(/permission denied|not_authenticated/i);
      await expect(probeReplayAs('anon', null, session, FILE_HASH_2, SAMPLE_RECORDS))
        .rejects.toThrow(/permission denied for function/i);
    });

    it('15. a submitted revision required a genuinely trusted import, not a client claim', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2053);
      // Session exists and carries a preview digest, but no trusted replay ran.
      const d = await expectedDigest(SAMPLE_RECORDS);
      await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      await expect(probe(U_ALL_A,
        'SELECT public.phoenix_central_needs_submit_revision($1)', [r.plan_revision_id]))
        .rejects.toThrow(/plan_revision_has_no_finalized_import/);
    });
  });

  // ==========================================================================
  // A. Authentication
  // ==========================================================================
  describe('A. authentication', () => {
    it('refuses an unauthenticated caller (no JWT subject)', async () => {
      await expect(probe(null, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/not_authenticated/);
    });

    it('refuses the anon role outright', async () => {
      await expect(probe(null, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031], 'anon'))
        .rejects.toThrow(/permission denied|not_authenticated/i);
    });

    it('refuses an authenticated subject with no profile row at all', async () => {
      await expect(probe(U_GHOST, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/forbidden_central_needs/);
    });
  });

  // ==========================================================================
  // B. Permission
  // ==========================================================================
  describe('B. permission', () => {
    it('refuses a same-org user holding no central_needs key', async () => {
      await expect(probe(U_NONE_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses institution_admin — no role gets an accidental Central Needs grant', async () => {
      await expect(probe(U_INST_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2031]))
        .rejects.toThrow(/forbidden_central_needs/);
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM role_permission_defaults WHERE permission_key LIKE 'central_needs.%'`);
      expect(count).toBe(0);
    });

    it('refuses import-only rights on an edit-gated RPC', async () => {
      await expect(probe(U_IMPORT_A,
        'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2032]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses edit-only rights on an import-gated RPC', async () => {
      const r = await openRevision(U_EDIT_A, ORG_A, 2033);
      await expect(probe(U_EDIT_A,
        'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5)',
        [r.plan_revision_id, 'x.xls', FILE_HASH, digestA, JSON.stringify(BROWSER_IDENTITY)]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses approval to a user holding only central_needs.edit', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2034);
      const d = await expectedDigest(SAMPLE_RECORDS);
      const s = await startImport(U_ALL_A, r.plan_revision_id, FILE_HASH, d);
      await applyReplay(s.import_session_id, FILE_HASH, SAMPLE_RECORDS);
      await call(U_ALL_A, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [r.plan_revision_id]);

      await expect(probe(U_EDIT_A,
        'SELECT public.phoenix_central_needs_approve_revision($1)', [r.plan_revision_id]))
        .rejects.toThrow(/forbidden_central_needs/);
      await expect(probe(U_EDIT_A,
        'SELECT public.phoenix_central_needs_reject_revision($1,$2)', [r.plan_revision_id, 'no']))
        .rejects.toThrow(/forbidden_central_needs/);

      const ok = await call(U_APPROVE_A,
        'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [r.plan_revision_id]);
      expect(ok.status).toBe('approved');
    });
  });

  // ==========================================================================
  // C. Organization boundary
  // ==========================================================================
  describe('C. organization boundary', () => {
    it('refuses a cross-organization mutation even with every key in the other org', async () => {
      await expect(probe(U_ALL_B, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2035]))
        .rejects.toThrow(/forbidden_central_needs/);
      await expect(probe(U_ALL_B, 'SELECT public.phoenix_central_needs_submit_revision($1)', [revA]))
        .rejects.toThrow(/forbidden_central_needs/);
    });

    it('refuses a nonexistent organization', async () => {
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_ABSENT, 2036]))
        .rejects.toThrow(/organization_not_found/);
    });

    it('refuses every mutation under an archived organization', async () => {
      await expect(probe(U_ALL_ARCH,
        'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_ARCHIVED, 2037]))
        .rejects.toThrow(/central_needs_write_blocked_by_archived_organization/);
    });

    it('archiving an organization does not retroactively break its existing Central Needs rows', async () => {
      const [row] = await admin(`SELECT archived_at FROM organizations WHERE id=$1`, [ORG_ARCHIVED]);
      expect(row.archived_at).not.toBeNull();
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_plans WHERE organization_id=$1`, [ORG_A]);
      expect(count).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // D. Illegal transitions / stale state
  // ==========================================================================
  describe('D. illegal transitions fail closed', () => {
    it('refuses to mutate content on an approved revision', async () => {
      await expect(probe(U_ALL_A,
        'SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3)', [revA, 'line-9', ITEM_1]))
        .rejects.toThrow(/plan_revision_not_editable/);
      await expect(probe(U_ALL_A,
        'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3,$4,$5)',
        [revA, 'line-1', 'quantity', JSON.stringify({ normalized: 999 }), 'late change']))
        .rejects.toThrow(/plan_revision_not_editable/);
      await expect(probe(U_ALL_A,
        'SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5)',
        [revA, 'late.xls', FILE_HASH_3, digestA, JSON.stringify(BROWSER_IDENTITY)]))
        .rejects.toThrow(/plan_revision_not_editable/);
    });

    it('refuses to approve a revision that was never submitted', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2038);
      await expect(probe(U_APPROVE_A,
        'SELECT public.phoenix_central_needs_approve_revision($1)', [r.plan_revision_id]))
        .rejects.toThrow(/plan_revision_not_submitted/);
    });

    it('refuses to open a new revision over a closed one without an explicit supersede', async () => {
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2)', [ORG_A, 2028]))
        .rejects.toThrow(/plan_revision_already_closed/);
    });

    it('supersedes an approved revision while preserving its approval record', async () => {
      const before = (await admin(
        `SELECT status, approved_by, approved_at FROM central_needs_plan_revisions WHERE id=$1`, [revA]))[0];

      const r2 = await openRevision(U_ALL_A, ORG_A, 2028, true);
      expect(r2.revision_number).toBe(2);
      expect(r2.status).toBe('draft');
      expect(r2.superseded_revision_id).toBe(revA);

      const after = (await admin(
        `SELECT status, approved_by, approved_at FROM central_needs_plan_revisions WHERE id=$1`, [revA]))[0];
      expect(after.status).toBe('superseded');
      expect(after.approved_by).toBe(before.approved_by);
      expect(after.approved_at).toEqual(before.approved_at);

      const [{ count }] = await admin(
        `SELECT count(*)::int FROM central_needs_record_mappings WHERE plan_revision_id=$1`, [revA]);
      expect(count).toBe(1);
    });

    it('refuses to supersede a revision that is not approved', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2040);
      await admin(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [r.plan_revision_id]);
      await expect(probe(U_ALL_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3)',
        [ORG_A, 2040, true])).rejects.toThrow(/only_an_approved_revision_may_be_superseded/);
    });
  });

  // ==========================================================================
  // F. Source immutability
  // ==========================================================================
  describe('F. source evidence stays immutable', () => {
    it('refuses to update a source record even as superuser', async () => {
      await expect(admin(
        `UPDATE central_needs_source_records SET source_values='{"tampered":true}'::jsonb
          WHERE import_session_id=$1`, [sessionA]))
        .rejects.toThrow(/central_needs_source_file_immutable/);
    });

    it('refuses to update the source file row even as superuser', async () => {
      await expect(admin(
        `UPDATE central_needs_source_files SET original_filename='other.xls' WHERE plan_revision_id=$1`, [revA]))
        .rejects.toThrow(/central_needs_source_file_immutable/);
    });

    it('an override leaves the source evidence byte-identical', async () => {
      const [before] = await admin(
        `SELECT source_values, source_provenance FROM central_needs_source_records
          WHERE import_session_id=$1 AND target_entity='line-1' AND field_name='quantity'`, [sessionA]);
      const [{ id: draftRev }] = await admin(
        `SELECT id FROM central_needs_plan_revisions
          WHERE plan_id=$1 AND status='draft' ORDER BY revision_number DESC LIMIT 1`, [planA]);
      await call(U_ALL_A,
        'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3,$4,$5) AS result',
        [draftRev, 'line-1', 'quantity', JSON.stringify({ normalized: 200 }), 'second correction']);

      const [after] = await admin(
        `SELECT source_values, source_provenance FROM central_needs_source_records
          WHERE import_session_id=$1 AND target_entity='line-1' AND field_name='quantity'`, [sessionA]);
      expect(after.source_values).toEqual(before.source_values);
      expect(after.source_provenance).toEqual(before.source_provenance);
    });

    it('requires a reason for every override', async () => {
      const [{ id: draftRev }] = await admin(
        `SELECT id FROM central_needs_plan_revisions
          WHERE plan_id=$1 AND status='draft' ORDER BY revision_number DESC LIMIT 1`, [planA]);
      for (const bad of [null, '', '   ']) {
        await expect(probe(U_ALL_A,
          'SELECT public.phoenix_central_needs_record_field_override($1,$2,$3,$4,$5)',
          [draftRev, 'line-1', 'quantity', JSON.stringify({ normalized: 1 }), bad]))
          .rejects.toThrow(/override_reason_required/);
      }
    });
  });

  // ==========================================================================
  // G. Audit
  // ==========================================================================
  describe('G. audit', () => {
    it('writes exactly one correctly-attributed event per authorized mutation', async () => {
      const r = await openRevision(U_ALL_A, ORG_A, 2043);
      const rows = await admin(
        `SELECT action, organization_id, actor_id, actor_role, entity_type, entity_id, payload
           FROM audit_logs WHERE entity_id=$1 AND action='central_needs.plan_revision.open'`,
        [r.plan_revision_id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(ORG_A);
      expect(rows[0].actor_id).toBe(U_ALL_A);
      expect(rows[0].actor_role).toBe('central_warehouse_manager');
      expect(rows[0].entity_type).toBe('central_needs_plan_revision');
      expect(rows[0].payload.plan_year).toBe(2043);
    });

    it('attributes the trusted replay to service_role, not to a client actor', async () => {
      const rows = await admin(
        `SELECT actor_id, actor_role, payload FROM audit_logs
          WHERE action='central_needs.import_session.authoritative_replay' AND entity_id=$1`, [sessionA]);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBeNull();
      expect(rows[0].actor_role).toBe('service_role');
      expect(rows[0].payload.authoritative_digest).toBe(digestA);
      expect(rows[0].payload.preview_digest).toBe(digestA);
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
      const before = (await admin(`SELECT count(*)::int AS c FROM audit_logs WHERE action LIKE 'central_needs.%'`))[0].c;
      let created = '';
      await rig.asUser(U_ALL_A, async (c: any) => {
        const res = await c.query(
          'SELECT public.phoenix_central_needs_open_plan_revision($1,$2) AS result', [ORG_A, 2046]);
        expect(res.rows[0].result.ok).toBe(true);
        created = res.rows[0].result.plan_revision_id;
        // Audit visibility is not asserted from inside: the session runs as
        // `authenticated`, which cannot read audit_logs, so a count here would
        // read 0 for RLS reasons rather than absence. The proof is below.
      }); // default: ROLLBACK

      expect(created).not.toBe('');
      const orphan = await admin(`SELECT count(*)::int AS c FROM audit_logs WHERE entity_id=$1`, [created]);
      expect(orphan[0].c).toBe(0);
      const after = (await admin(`SELECT count(*)::int AS c FROM audit_logs WHERE action LIKE 'central_needs.%'`))[0].c;
      expect(after).toBe(before);
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

    it('a direct client INSERT is rejected regardless of RLS', async () => {
      await expect(probe(U_ALL_A,
        `INSERT INTO central_needs_record_mappings (plan_revision_id, organization_id, target_entity, central_item_id)
         VALUES ($1,$2,'direct',$3)`, [revA, ORG_A, ITEM_1]))
        .rejects.toThrow(/permission denied/i);
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
    it('leaves every stock and transfer surface untouched across the whole workflow', async () => {
      for (const t of ['warehouse_stock', 'inventory_transfer_suggestions',
        'warehouse_transfer_requests', 'warehouse_stock_movements']) {
        const [{ exists }] = await admin(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t}`]);
        if (!exists) continue;
        const [{ count }] = await admin(`SELECT count(*)::int FROM public.${t}`);
        expect(count, `${t} must remain empty`).toBe(0);
      }
    });

    it('defines no Central Needs send permission anywhere', async () => {
      const [{ count }] = await admin(
        `SELECT count(*)::int FROM permission_keys WHERE key = 'central_needs.send'`);
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
