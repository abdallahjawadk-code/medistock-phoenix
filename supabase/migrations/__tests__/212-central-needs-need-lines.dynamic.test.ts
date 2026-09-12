/**
 * CN-2B CONFORMANCE (212) — DYNAMIC suite against the canonical replayed chain.
 *
 * Proves the operational Annual Needs projection on a real PostgreSQL: schema
 * shape and security posture, the beneficiary/warehouse/unit contracts, the
 * EXACT quantity contract (nothing is ever silently rounded, NaN and Infinity
 * are refused), MANDATORY source-record provenance whose contributions sum to
 * the approved quantity, canonical-material agreement with each row's existing
 * mapping, the proven cardinality (including the warehouse-aware NULLS NOT
 * DISTINCT scope key and the institution-level/warehouse-split exclusivity),
 * authorization and role boundaries, revision editability, the extended review
 * blockers, and — the one that protects live data — that an ALREADY-APPROVED
 * revision is never retroactively invalidated.
 *
 * Fixtures are seeded through the rig's superuser connection, exactly as the
 * 209/211 dynamic suites do: this suite tests 212's own contract, not 210/211's
 * import pipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_OWNER = '00000000-0000-0000-0000-000000212001'; // owns the plan
const ORG_BENE = '00000000-0000-0000-0000-000000212002'; // beneficiary institution
const ORG_BENE2 = '00000000-0000-0000-0000-000000212003'; // a second beneficiary
const ORG_AUTHORITY = '00000000-0000-0000-0000-000000212004'; // not a care_institution
const ORG_INACTIVE = '00000000-0000-0000-0000-000000212005'; // inactive institution
const ORG_OTHER = '00000000-0000-0000-0000-000000212006'; // unrelated owner org

const U_EDIT = '00000000-0000-0000-0000-000000212401'; // full central_needs on owner
const U_NOPERM = '00000000-0000-0000-0000-000000212402'; // owner org, no keys
const U_OTHER = '00000000-0000-0000-0000-000000212403'; // different owner org
const U_INST = '00000000-0000-0000-0000-000000212404'; // institution_admin, all keys
const U_OUTLET = '00000000-0000-0000-0000-000000212405'; // outlet_officer, all keys

const ITEM_A = '00000000-0000-0000-0000-000000212801';
const ITEM_B = '00000000-0000-0000-0000-000000212802';

const WH_BENE = '00000000-0000-0000-0000-000000212901'; // belongs to ORG_BENE
const WH_BENE_2 = '00000000-0000-0000-0000-000000212903'; // also ORG_BENE
const WH_FOREIGN = '00000000-0000-0000-0000-000000212902'; // belongs to ORG_BENE2

const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};

const SET_NEED_LINE =
  'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, text, text, uuid, text)';

interface Row {
  entity: string;
  item?: string | null;
  decision?: 'mapped' | 'not_applicable';
  fields?: Array<{ name: string; value: unknown }>;
}

run('CN-2B/212 operational need lines — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2010;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /**
   * A revision with one completed session. Each row carries its own source
   * records (cells) and its own canonical mapping decision, so provenance can be
   * designated at the record level the way the real import pipeline produces it.
   */
  async function scenario(opts: { status?: string; rows?: Row[] } = {}) {
    const y = year++;
    const rows: Row[] = opts.rows ?? [{
      entity: 'sheet:0:row:5',
      fields: [{ name: 'requested', value: 100 }, { name: 'final', value: 120 }],
    }];
    const [{ id: planId }] = await admin(
      `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`,
      [ORG_OWNER, y]);
    const [{ id: revId }] = await admin(
      `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
         VALUES ($1,$2,1,$3) RETURNING id`,
      [planId, ORG_OWNER, opts.status ?? 'draft']);
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files
         (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [revId, ORG_OWNER, `needs-${y}.xls`, `${y}`.padStart(64, 'a'), 1024]);
    // M211 requires a completed session to carry its finalization evidence
    // (preview_digest = authoritative_digest, parser identity, completed_at).
    const digest = `${y}`.padStart(64, 'd');
    const [{ id: sessionId }] = await admin(
      `INSERT INTO central_needs_import_sessions
         (plan_revision_id, organization_id, source_file_id, status,
          preview_digest, authoritative_digest, parser_identity, completed_at)
       VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`,
      [revId, ORG_OWNER, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);

    const records = new Map<string, string>();
    let ordinal = 0;
    for (const row of rows) {
      for (const f of row.fields ?? [{ name: 'final', value: 100 }]) {
        ordinal += 1;
        const [{ id }] = await admin(
          `INSERT INTO central_needs_source_records
             (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
          [sessionId, ORG_OWNER, ordinal, row.entity, f.name, JSON.stringify({ value: f.value })]);
        records.set(`${row.entity}::${f.name}`, id);
      }
      const decision = row.decision ?? 'mapped';
      await admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId, ORG_OWNER, row.entity,
          decision === 'mapped' ? (row.item ?? ITEM_A) : null, decision,
          decision === 'mapped' ? null : 'out of scope']);
    }
    return { planId, revId, sessionId, records, rows, year: y };
  }

  /** `[{ sourceRecordId, designatedQuantity, appliedOverrideId }]` as jsonb text. */
  const sources = (...items: Array<[string, string | number] | [string, string | number, string | null]>) =>
    JSON.stringify(items.map(([id, qty, override]) => ({
      sourceRecordId: id,
      designatedQuantity: typeof qty === 'number' ? qty : String(qty),
      appliedOverrideId: override ?? null,
    })));

  const setLine = (
    userId: string,
    revId: string,
    o: Partial<{
      beneficiary: string; item: string; qty: string | number; reason: string;
      unit: string | null; state: string; warehouse: string | null; sourceUnit: string | null;
      sources: string;
    }> = {},
  ) => call(userId,
    `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result`,
    // `'sources' in o`, never `??`: a test that deliberately passes null must
    // reach the server as NULL rather than be turned into an empty array here.
    [revId, o.beneficiary ?? ORG_BENE, o.item ?? ITEM_A, 'qty' in o ? o.qty : 100, o.reason ?? 'mapped by reviewer',
      'sources' in o ? o.sources : '[]', o.unit === undefined ? 'box' : o.unit, o.state ?? 'canonical',
      o.warehouse ?? null, o.sourceUnit ?? null]);

  const blockers = (revId: string) =>
    admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_OWNER}','CN212-OWNER','مالك','p212-owner','care_institution','hospital'),
        ('${ORG_BENE}','CN212-BENE','منتفع','p212-bene','care_institution','hospital'),
        ('${ORG_BENE2}','CN212-BENE2','منتفع٢','p212-bene2','care_institution','hospital'),
        ('${ORG_INACTIVE}','CN212-INACT','معطل','p212-inact','care_institution','hospital'),
        ('${ORG_OTHER}','CN212-OTHER','اخر','p212-other','care_institution','hospital'),
        ('${ORG_AUTHORITY}','CN212-AUTH','سلطة','p212-auth','pharmacy_department_authority',NULL)
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_EDIT}','p212-edit@rig'),('${U_NOPERM}','p212-noperm@rig'),
        ('${U_OTHER}','p212-other@rig'),('${U_INST}','p212-inst@rig'),('${U_OUTLET}','p212-outlet@rig')
        ON CONFLICT (id) DO NOTHING;`);

      for (const [u, org, role] of [
        [U_EDIT, ORG_OWNER, 'central_warehouse_manager'],
        [U_NOPERM, ORG_OWNER, 'central_warehouse_manager'],
        [U_OTHER, ORG_OTHER, 'central_warehouse_manager'],
        [U_INST, ORG_OWNER, 'institution_admin'],
        [U_OUTLET, ORG_OWNER, 'outlet_officer'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1,status='active',organization_id=$2 WHERE id=$3`,
          [role, org, u]);
      }
      // Every user except U_NOPERM holds every key, so only the intended
      // dimension (permission, organization or role class) can refuse them.
      for (const u of [U_EDIT, U_OTHER, U_INST, U_OUTLET]) {
        for (const k of ['view', 'import', 'edit', 'approve']) {
          await c.query(
            `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
               ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`,
            [u, `central_needs.${k}`]);
        }
      }

      await c.query(`INSERT INTO central_items (id,name,name_ar,unit) VALUES
        ('${ITEM_A}','Paracetamol 500mg','باراسيتامول','box'),
        ('${ITEM_B}','Amoxicillin 250mg','اموكسيسيلين','vial') ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status) VALUES
        ('${WH_BENE}','${ORG_BENE}','BENE WH','مخزن المنتفع','active'),
        ('${WH_BENE_2}','${ORG_BENE}','BENE WH 2','مخزن المنتفع٢','active'),
        ('${WH_FOREIGN}','${ORG_BENE2}','OTHER WH','مخزن اخر','active')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`UPDATE organizations SET status='inactive' WHERE id='${ORG_INACTIVE}'`);
    });
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // ---- A. SCHEMA AND SECURITY POSTURE ------------------------------------
  describe('A. schema and security posture', () => {
    it('creates both relations with RLS enabled and forced', async () => {
      const rows = await admin(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid IN ('public.central_needs_need_lines'::regclass,
                        'public.central_needs_need_line_sources'::regclass)
          ORDER BY relname`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.relrowsecurity, r.relname).toBe(true);
        expect(r.relforcerowsecurity, r.relname).toBe(true);
      }
    });

    it('stores BOTH quantities as unconstrained numeric — a typmod would round', async () => {
      const rows = await admin(
        `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
           FROM information_schema.columns
          WHERE table_schema='public'
            AND (table_name,column_name) IN
                (('central_needs_need_lines','approved_quantity'),
                 ('central_needs_need_line_sources','designated_quantity'))
          ORDER BY table_name`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.data_type, r.table_name).toBe('numeric');
        expect(r.numeric_precision, r.table_name).toBeNull();
        expect(r.numeric_scale, r.table_name).toBeNull();
      }
    });

    it('keys the canonical line on revision + beneficiary + item + warehouse, NULLS NOT DISTINCT', async () => {
      const [{ def }] = await admin(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid='public.central_needs_need_lines'::regclass AND contype='u'
            AND conname='central_needs_need_lines_scope_key'`);
      expect(def).toBe(
        'UNIQUE NULLS NOT DISTINCT (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id)');
    });

    it('lets one source RECORD feed at most one need line', async () => {
      const [{ def }] = await admin(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid='public.central_needs_need_line_sources'::regclass AND contype='u'
            AND conname='central_needs_need_line_sources_record_key'`);
      expect(def).toBe('UNIQUE (source_record_id)');
    });

    it('carries the deferred integrity assertion on both tables', async () => {
      const rows = await admin(
        `SELECT c.relname, t.tgdeferrable, t.tginitdeferred, t.tgconstraint <> 0 AS is_constraint
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE t.tgname='assert_need_line_integrity' AND NOT t.tgisinternal
          ORDER BY c.relname`);
      expect(rows.map((r: any) => r.relname)).toEqual(
        ['central_needs_need_line_sources', 'central_needs_need_lines']);
      for (const r of rows) {
        expect(r.tgdeferrable, r.relname).toBe(true);
        expect(r.tginitdeferred, r.relname).toBe(true);
        expect(r.is_constraint, r.relname).toBe(true);
      }
    });

    it('grants authenticated SELECT only — no direct write path', async () => {
      const rows = await admin(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee='authenticated' AND table_schema='public'
            AND table_name IN ('central_needs_need_lines','central_needs_need_line_sources')
          ORDER BY privilege_type`);
      expect([...new Set(rows.map((r: any) => r.privilege_type))]).toEqual(['SELECT']);
    });

    it('pins search_path on every function it defines', async () => {
      const rows = await admin(
        `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN (
            'phoenix_central_needs_set_need_line',
            '_phoenix_central_needs_assert_beneficiary_v1',
            '_phoenix_central_needs_assert_need_line_integrity_v1')`);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.proconfig, r.proname).toContain('search_path=public, pg_temp');
      }
    });
  });

  // ---- B. EXACT QUANTITY CONTRACT ----------------------------------------
  describe('B. quantity and unit contract', () => {
    it('accepts zero as a valid approved quantity', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: 0, sources: sources([id, '0']) });
      expect(r.ok).toBe(true);
      const [row] = await admin(
        `SELECT approved_quantity::text AS q FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.q).toBe('0');
    });

    it('PRESERVES a 4-decimal quantity exactly — the old numeric(20,3) would have rounded it', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: '120.1239', sources: sources([id, '120.1239']) });
      const [row] = await admin(
        `SELECT approved_quantity::text AS q, scale(approved_quantity) AS s
           FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.q).toBe('120.1239');
      expect(row.s).toBe(4);
      // The contrast this test exists for: what a declared scale would have done.
      const [{ rounded }] = await admin(`SELECT '120.1239'::numeric(20,3)::text AS rounded`);
      expect(rounded).toBe('120.124');
      expect(row.q).not.toBe(rounded);
      // And the designated contribution is stored just as exactly.
      const [link] = await admin(
        `SELECT designated_quantity::text AS q FROM central_needs_need_line_sources WHERE need_line_id=$1`,
        [r.need_line_id]);
      expect(link.q).toBe('120.1239');
    });

    it('rejects a negative quantity', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { qty: -1, sources: sources([id, '-1']) }))
        .rejects.toThrow(/designated_quantity_must_not_be_negative|approved_quantity_must_not_be_negative/);
    });

    it('rejects a missing quantity — blank is not zero', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { qty: null as unknown as number, sources: sources([id, '0']) }))
        .rejects.toThrow(/approved_quantity_required/);
    });

    it('rejects NaN and Infinity rather than storing a non-finite quantity', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { qty: 'NaN', sources: sources([id, 'NaN']) }))
        .rejects.toThrow(/must_be_finite/);
      const s2 = await scenario();
      const id2 = s2.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s2.revId, { qty: 'Infinity', sources: sources([id2, 'Infinity']) }))
        .rejects.toThrow(/must_be_finite/);
    });

    it('refuses a non-numeric designated contribution instead of coercing it', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, {
        qty: 100,
        sources: JSON.stringify([{ sourceRecordId: id, designatedQuantity: '12 boxes' }]),
      })).rejects.toThrow(/designated_quantity_not_numeric/);
    });

    it('refuses a unit outside the canonical central_items vocabulary', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { unit: 'crate', sources: sources([id, '100']) }))
        .rejects.toThrow(/central_needs_need_lines_unit_vocab_chk|unit/);
    });

    it('requires a canonical unit when the state is canonical', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { unit: null, sources: sources([id, '100']) }))
        .rejects.toThrow(/canonical_unit_required/);
    });

    it('refuses a guessed conversion: conversion_required must carry no unit', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: 'box', sources: sources([id, '100']),
      })).rejects.toThrow(/conversion_required_must_not_carry_unit/);
    });

    it('accepts conversion_required with no unit and keeps the source unit as evidence', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: null, sourceUnit: 'علبة ٢٠ قرص',
        sources: sources([id, '100']),
      });
      const [row] = await admin(
        `SELECT approved_unit, unit_conversion_state, source_unit_text
           FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.approved_unit).toBeNull();
      expect(row.unit_conversion_state).toBe('conversion_required');
      expect(row.source_unit_text).toBe('علبة ٢٠ قرص');
    });
  });

  // ---- C. BENEFICIARY AND WAREHOUSE -------------------------------------
  describe('C. beneficiary and target warehouse', () => {
    const one = async () => {
      const s = await scenario();
      return { s, id: s.records.get('sheet:0:row:5::final')! };
    };

    it('persists the beneficiary as a dimension distinct from the owning org', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const [row] = await admin(
        `SELECT organization_id, beneficiary_organization_id FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(row.organization_id).toBe(ORG_OWNER);
      expect(row.beneficiary_organization_id).toBe(ORG_BENE);
    });

    it('refuses a beneficiary that is not a care institution', async () => {
      const { s, id } = await one();
      await expect(setLine(U_EDIT, s.revId, { beneficiary: ORG_AUTHORITY, sources: sources([id, '100']) }))
        .rejects.toThrow(/beneficiary_must_be_care_institution/);
    });

    it('refuses an inactive beneficiary', async () => {
      const { s, id } = await one();
      await expect(setLine(U_EDIT, s.revId, { beneficiary: ORG_INACTIVE, sources: sources([id, '100']) }))
        .rejects.toThrow(/beneficiary_organization_not_active/);
    });

    it('treats target_warehouse_id as optional (institution-level need)', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const [row] = await admin(
        `SELECT target_warehouse_id FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.target_warehouse_id).toBeNull();
    });

    it('accepts a warehouse owned by the beneficiary', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, sources: sources([id, '100']) });
      const [row] = await admin(
        `SELECT target_warehouse_id FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.target_warehouse_id).toBe(WH_BENE);
    });

    it('refuses a warehouse belonging to another organization', async () => {
      const { s, id } = await one();
      await expect(setLine(U_EDIT, s.revId, { warehouse: WH_FOREIGN, sources: sources([id, '100']) }))
        .rejects.toThrow(/target_warehouse_not_owned_by_beneficiary/);
    });
  });

  // ---- D. AUTHORIZATION --------------------------------------------------
  describe('D. authorization', () => {
    const one = async () => {
      const s = await scenario();
      return { s, id: s.records.get('sheet:0:row:5::final')! };
    };

    it('allows a central warehouse manager holding central_needs.edit', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(r.ok).toBe(true);
    });

    it('denies a user in the owning org holding no central_needs key', async () => {
      const { s, id } = await one();
      await expect(setLine(U_NOPERM, s.revId, { sources: sources([id, '100']) })).rejects.toThrow();
    });

    it('denies a user from a different organization', async () => {
      const { s, id } = await one();
      await expect(setLine(U_OTHER, s.revId, { sources: sources([id, '100']) })).rejects.toThrow();
    });

    it('denies institution_admin and outlet_officer even holding every key', async () => {
      const { s, id } = await one();
      await expect(setLine(U_INST, s.revId, { sources: sources([id, '100']) })).rejects.toThrow();
      await expect(setLine(U_OUTLET, s.revId, { sources: sources([id, '100']) })).rejects.toThrow();
    });

    it('keeps the internal helpers off the client surface', async () => {
      const rows = await admin(
        `SELECT p.proname,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN (
            '_phoenix_central_needs_assert_beneficiary_v1',
            '_phoenix_central_needs_assert_need_line_integrity_v1')`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.auth_exec, r.proname).toBe(false);
        expect(r.anon_exec, r.proname).toBe(false);
      }
    });

    it('denies anon execution of the write primitive', async () => {
      const [{ ok }] = await admin(
        `SELECT has_function_privilege('anon', '${SET_NEED_LINE}', 'EXECUTE') AS ok`);
      expect(ok).toBe(false);
    });

    it('refuses a direct authenticated INSERT into the need-line table', async () => {
      const s = await scenario();
      await expect(call(U_EDIT,
        `INSERT INTO central_needs_need_lines
           (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
            approved_quantity, approved_unit, mapping_reason)
         VALUES ($1,$2,$3,$4,1,'box','direct') RETURNING id AS result`,
        [s.revId, ORG_OWNER, ORG_BENE, ITEM_A])).rejects.toThrow();
    });
  });

  // ---- E. REVISION LIFECYCLE --------------------------------------------
  describe('E. revision lifecycle', () => {
    it('refuses mapping on a non-draft revision', async () => {
      const s = await scenario({ status: 'submitted' });
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { sources: sources([id, '100']) })).rejects.toThrow();
    });

    it('NEVER retroactively invalidates an already-approved revision', async () => {
      // An approved revision with a mapped row and no need line at all — exactly
      // the shape a revision approved before M212 has.
      const s = await scenario({ status: 'draft' });
      const id = s.records.get('sheet:0:row:5::final')!;
      await admin(`UPDATE central_needs_plan_revisions SET status='submitted' WHERE id=$1`, [s.revId]);
      // The revision table pairs approved_at with approved_by, so both are set.
      await admin(
        `UPDATE central_needs_plan_revisions SET status='approved', approved_at=now(), approved_by=$2
          WHERE id=$1`, [s.revId, U_EDIT]);

      const [{ n: lines }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(lines).toBe(0);

      // The approval stands, and the blockers function is not consulted by the
      // approve path at all — the only callers are the submit gate (draft-only)
      // and the read-only readiness query.
      const [{ status }] = await admin(
        `SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(status).toBe('approved');
      const callers = await admin(
        // prokind='f': pg_get_functiondef raises on an aggregate.
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prokind='f'
            AND pg_get_functiondef(p.oid) LIKE '%_phoenix_central_needs_review_blockers_v1%'
            AND p.proname <> '_phoenix_central_needs_review_blockers_v1'
          ORDER BY p.proname`);
      expect(callers.map((r: any) => r.proname)).toEqual(
        ['phoenix_central_needs_review_readiness', 'phoenix_central_needs_submit_revision']);
      // And mapping an approved revision is refused, so history cannot be
      // rewritten in place either.
      await expect(setLine(U_EDIT, s.revId, { sources: sources([id, '100']) })).rejects.toThrow();
    });
  });

  // ---- F. MANDATORY SOURCE LINEAGE (review blocker 2) -------------------
  describe('F. source lineage is mandatory', () => {
    it('refuses an EMPTY designated-source array', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { sources: '[]' }))
        .rejects.toThrow(/need_line_requires_source_lineage/);
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(0);
    });

    it('refuses a NULL designated-source array', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { sources: null as unknown as string }))
        .rejects.toThrow(/quantity_sources_must_be_array/);
    });

    it('has NO overload that omits the provenance argument', async () => {
      const s = await scenario();
      await expect(call(U_EDIT,
        `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5) AS result`,
        [s.revId, ORG_BENE, ITEM_A, 100, 'no lineage'])).rejects.toThrow(/does not exist/);
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
          WHERE ns.nspname='public' AND p.proname='phoenix_central_needs_set_need_line'`);
      expect(n).toBe(1);
    });

    it('refuses an orphan line even when inserted with full privileges', async () => {
      const s = await scenario();
      await expect(admin(
        `INSERT INTO central_needs_need_lines
           (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
            approved_quantity, approved_unit, mapping_reason)
         VALUES ($1,$2,$3,$4,5,'box','privileged orphan')`,
        [s.revId, ORG_OWNER, ORG_BENE, ITEM_A]))
        .rejects.toThrow(/need_line_requires_source_lineage/);
    });

    it('refuses DELETING the last link of an existing line', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      await expect(admin(
        `DELETE FROM central_needs_need_line_sources WHERE need_line_id=$1`, [r.need_line_id]))
        .rejects.toThrow(/need_line_requires_source_lineage/);
    });

    it('refuses a source record that belongs to another revision', async () => {
      const a = await scenario();
      const b = await scenario();
      const foreign = b.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, a.revId, { sources: sources([foreign, '100']) }))
        .rejects.toThrow(/source_link_session_not_in_revision/);
    });

    it('refuses a source record whose row was dispositioned not_applicable', async () => {
      const s = await scenario({
        rows: [{ entity: 'sheet:0:row:9', decision: 'not_applicable', fields: [{ name: 'final', value: 10 }] }],
      });
      const id = s.records.get('sheet:0:row:9::final')!;
      await expect(setLine(U_EDIT, s.revId, { sources: sources([id, '10']) }))
        .rejects.toThrow(/source_link_requires_mapped_disposition/);
    });

    it('refuses a source record that does not exist', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, {
        sources: sources(['00000000-0000-0000-0000-0000000000ff', '10']),
      })).rejects.toThrow(/source_record_not_found/);
    });
  });

  // ---- G. CANONICAL MATERIAL CONSISTENCY (review blocker 3) -------------
  describe('G. canonical material consistency', () => {
    it('HARD REJECTS a need line for ITEM_B fed by a source mapped to ITEM_A', async () => {
      const s = await scenario(); // row mapped to ITEM_A
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { item: ITEM_B, sources: sources([id, '100']) }))
        .rejects.toThrow(/source_link_material_mismatch/);
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(0);
    });

    it('rejects the same mismatch when inserted with full privileges, at COMMIT', async () => {
      const s = await scenario(); // mapped to ITEM_A
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        const { rows } = await c.query(
          `INSERT INTO central_needs_need_lines
             (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
              approved_quantity, approved_unit, mapping_reason)
           VALUES ($1,$2,$3,$4,7,'box','privileged mismatch') RETURNING id`,
          [s.revId, ORG_OWNER, ORG_BENE, ITEM_B]);
        await c.query(
          `INSERT INTO central_needs_need_line_sources
             (need_line_id, organization_id, source_record_id, designated_quantity)
           VALUES ($1,$2,$3,7)`,
          [rows[0].id, ORG_OWNER, id]);
        await c.query('COMMIT');
      })).rejects.toThrow(/need_line_material_mapping_conflict/);
      await rig.asAdmin((c: any) => c.query('ROLLBACK').catch(() => {}));
    });

    it('accepts two lines for two materials when each row is mapped to its own', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', item: ITEM_A, fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', item: ITEM_B, fields: [{ name: 'final', value: 20 }] },
        ],
      });
      const a = await setLine(U_EDIT, s.revId, {
        item: ITEM_A, qty: 10, sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      const b = await setLine(U_EDIT, s.revId, {
        item: ITEM_B, qty: 20, unit: 'vial', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      });
      expect(a.need_line_id).not.toBe(b.need_line_id);
    });

    it('surfaces a LATER re-mapping as a review blocker instead of rewriting the line', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .not.toContain('need_line_material_mapping_divergent');

      // The canonical mapping is mutable by design (M210). Re-map the row.
      await admin(
        `UPDATE central_needs_record_mappings SET central_item_id=$1 WHERE import_session_id=$2`,
        [ITEM_B, s.sessionId]);

      const after = await blockers(s.revId);
      expect(after.map((b: any) => b.blocker)).toContain('need_line_material_mapping_divergent');
      // The approved line itself is untouched — nothing silently followed.
      const [line] = await admin(
        `SELECT central_item_id FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(line.central_item_id).toBe(ITEM_A);
    });
  });

  // ---- H. QUANTITY PROVENANCE (review blocker 4) ------------------------
  describe('H. approved-quantity provenance', () => {
    it('refuses a total that is not the sum of its designated contributions', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await expect(setLine(U_EDIT, s.revId, { qty: '200', sources: sources([id, '120']) }))
        .rejects.toThrow(/need_line_quantity_provenance_mismatch/);
    });

    it('preserves N -> 1 provenance: every contributing record and its exact share', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 5.5 }] },
          { entity: 'sheet:0:row:3', fields: [{ name: 'final', value: 0.25 }] },
        ],
      });
      const ids = ['sheet:0:row:1::final', 'sheet:0:row:2::final', 'sheet:0:row:3::final']
        .map((k) => s.records.get(k)!);
      const r = await setLine(U_EDIT, s.revId, {
        qty: '15.75',
        sources: sources([ids[0], '10'], [ids[1], '5.5'], [ids[2], '0.25']),
      });
      expect(r.source_link_count).toBe(3);
      const links = await admin(
        `SELECT source_record_id, designated_quantity::text AS q
           FROM central_needs_need_line_sources WHERE need_line_id=$1
          ORDER BY designated_quantity`, [r.need_line_id]);
      expect(links.map((l: any) => l.q)).toEqual(['0.25', '5.5', '10']);
      const [{ proven }] = await admin(
        `SELECT (n.approved_quantity = (SELECT sum(designated_quantity)
                                          FROM central_needs_need_line_sources
                                         WHERE need_line_id = n.id)) AS proven
           FROM central_needs_need_lines n WHERE n.id=$1`, [r.need_line_id]);
      expect(proven).toBe(true);
    });

    it('designates ONE cell of a multi-quantity row — the row alone is not the provenance', async () => {
      const s = await scenario({
        rows: [{
          entity: 'sheet:0:row:7',
          fields: [{ name: 'requested', value: 900 }, { name: 'final', value: 120 }],
        }],
      });
      const finalCell = s.records.get('sheet:0:row:7::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: '120', sources: sources([finalCell, '120']) });
      const [link] = await admin(
        `SELECT r.field_name FROM central_needs_need_line_sources ls
           JOIN central_needs_source_records r ON r.id = ls.source_record_id
          WHERE ls.need_line_id=$1`, [r.need_line_id]);
      expect(link.field_name).toBe('final');
    });

    it('pins a field override the reviewer relied on, and validates it belongs to that record', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      // M210 made source_record_id NOT NULL: an override corrects one exact record.
      const [{ id: overrideId }] = await admin(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
            final_value, override_reason)
         VALUES ($1,$2,$3,'sheet:0:row:5','final','130'::jsonb,'committee correction') RETURNING id`,
        [s.revId, ORG_OWNER, id]);
      const r = await setLine(U_EDIT, s.revId, { qty: '130', sources: sources([id, '130', overrideId]) });
      const [link] = await admin(
        `SELECT applied_override_id FROM central_needs_need_line_sources WHERE need_line_id=$1`,
        [r.need_line_id]);
      expect(link.applied_override_id).toBe(overrideId);

      // An override of a DIFFERENT record cannot be pinned to this one.
      const other = s.records.get('sheet:0:row:5::requested')!;
      const [{ id: wrongOverride }] = await admin(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
            final_value, override_reason)
         VALUES ($1,$2,$3,'sheet:0:row:5','requested','999'::jsonb,'unrelated') RETURNING id`,
        [s.revId, ORG_OWNER, other]);
      await expect(setLine(U_EDIT, s.revId, { qty: '130', sources: sources([id, '130', wrongOverride]) }))
        .rejects.toThrow(/applied_override_does_not_match_source_record/);
    });

    it('cannot split one imported ROW across two need lines', async () => {
      const s = await scenario({
        rows: [{
          entity: 'sheet:0:row:8',
          fields: [{ name: 'q1', value: 10 }, { name: 'q2', value: 20 }],
        }],
      });
      const q1 = s.records.get('sheet:0:row:8::q1')!;
      const q2 = s.records.get('sheet:0:row:8::q2')!;
      await setLine(U_EDIT, s.revId, { qty: '10', sources: sources([q1, '10']) });
      // A second line for the same scope upserts the first, so force the split by
      // aiming the second line at a different beneficiary.
      await expect(setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE2, qty: '20', sources: sources([q2, '20']),
      })).rejects.toThrow(/source_row_split_across_need_lines/);
    });

    it('writes the provenance into the audit payload', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: '120.1239', sources: sources([id, '120.1239']) });
      const [log] = await admin(
        `SELECT payload FROM audit_logs
          WHERE action='central_needs.need_line.set' AND entity_id=$1
          ORDER BY created_at DESC LIMIT 1`, [r.need_line_id]);
      expect(log.payload.approved_quantity).toBe('120.1239');
      expect(log.payload.designated_sum).toBe('120.1239');
      expect(log.payload.source_link_count).toBe(1);
      expect(log.payload.quantity_sources).toHaveLength(1);
      expect(log.payload.quantity_sources[0].source_record_id).toBe(id);
      expect(log.payload.quantity_sources[0].designated_quantity).toBe('120.1239');
    });
  });

  // ---- I. PROVEN CARDINALITY (review blocker 1) -------------------------
  describe('I. cardinality', () => {
    it('re-mapping the same scope UPDATES in place rather than double counting', async () => {
      const s = await scenario({
        rows: [{ entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 120 }] }],
      });
      const id = s.records.get('sheet:0:row:5::final')!;
      const first = await setLine(U_EDIT, s.revId, { qty: '100', sources: sources([id, '100']) });
      const second = await setLine(U_EDIT, s.revId, { qty: '140', sources: sources([id, '140']) });
      expect(second.need_line_id).toBe(first.need_line_id);
      const rows = await admin(
        `SELECT approved_quantity::text AS q FROM central_needs_need_lines WHERE plan_revision_id=$1`,
        [s.revId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].q).toBe('140');
    });

    it('allows the same material for a DIFFERENT beneficiary', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE, qty: '10', sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      await setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE2, qty: '20', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      });
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(2);
    });

    it('allows a warehouse-targeted split across TWO warehouses of one beneficiary', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        warehouse: WH_BENE, qty: '10', sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      await setLine(U_EDIT, s.revId, {
        warehouse: WH_BENE_2, qty: '20', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      });
      const rows = await admin(
        `SELECT target_warehouse_id FROM central_needs_need_lines WHERE plan_revision_id=$1
          ORDER BY target_warehouse_id`, [s.revId]);
      expect(rows.map((r: any) => r.target_warehouse_id).sort()).toEqual([WH_BENE, WH_BENE_2].sort());
    });

    it('REFUSES mixing an institution-level line with a warehouse-targeted one', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        qty: '10', sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      await expect(setLine(U_EDIT, s.revId, {
        warehouse: WH_BENE, qty: '20', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      })).rejects.toThrow(/need_line_scope_mixes_institution_and_warehouse/);
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(1);
    });

    it('consolidates many source rows of one material into ONE canonical line', async () => {
      // The corpus shape this migration was measured against: the same material
      // on several rows with different numbers.
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:63', fields: [{ name: 'final', value: 40 }] },
          { entity: 'sheet:0:row:84', fields: [{ name: 'final', value: 35 }] },
        ],
      });
      const r = await setLine(U_EDIT, s.revId, {
        qty: '75',
        sources: sources(
          [s.records.get('sheet:0:row:63::final')!, '40'],
          [s.records.get('sheet:0:row:84::final')!, '35']),
      });
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(1);
      expect(r.source_link_count).toBe(2);
      // Neither source record was rewritten to achieve the consolidation.
      const raw = await admin(
        `SELECT source_values->>'value' AS v FROM central_needs_source_records
          WHERE import_session_id=$1 ORDER BY record_ordinal`, [s.sessionId]);
      expect(raw.map((x: any) => x.v)).toEqual(['40', '35']);
    });
  });

  // ---- J. REVIEW BLOCKERS ----------------------------------------------
  describe('J. review blockers', () => {
    it('preserves every pre-212 blocker branch', async () => {
      const [{ def }] = await admin(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='_phoenix_central_needs_review_blockers_v1'`);
      for (const branch of [
        'no_finalized_import', 'import_session_still_open',
        'completed_session_not_in_trusted_batch', 'incomplete_trusted_batch',
        'target_entity_without_disposition',
      ]) expect(def, branch).toContain(branch);
    });

    it('blocks a mapped row that no need line claims, and clears once it is claimed', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('mapped_target_entity_without_need_line');
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .not.toContain('mapped_target_entity_without_need_line');
    });

    it('blocks while any need line still needs a unit conversion', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: null, sources: sources([id, '100']),
      });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('need_line_unit_conversion_required');
    });

    it('blocks an ineligible beneficiary that bypassed the write RPC (defence in depth)', async () => {
      // organization_kind is immutable by trigger and an inactive beneficiary is
      // refused at write time, so the only way to reach this state is to bypass
      // the RPC entirely — which is exactly the case this branch defends against.
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        const { rows } = await c.query(
          `INSERT INTO central_needs_need_lines
             (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
              approved_quantity, approved_unit, mapping_reason)
           VALUES ($1,$2,$3,$4,100,'box','privileged insert') RETURNING id`,
          [s.revId, ORG_OWNER, ORG_INACTIVE, ITEM_A]);
        await c.query(
          `INSERT INTO central_needs_need_line_sources
             (need_line_id, organization_id, source_record_id, designated_quantity)
           VALUES ($1,$2,$3,100)`,
          [rows[0].id, ORG_OWNER, id]);
        await c.query('COMMIT');
      });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('need_line_beneficiary_ineligible');
    });

    it('blocks a target warehouse that stopped belonging to the beneficiary', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, sources: sources([id, '100']) });
      await admin(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_BENE2, WH_BENE]);
      try {
        expect((await blockers(s.revId)).map((b: any) => b.blocker))
          .toContain('need_line_warehouse_org_mismatch');
      } finally {
        await admin(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_BENE, WH_BENE]);
      }
    });
  });

  // ---- K. CROSS-ORGANIZATION ISOLATION ---------------------------------
  describe('K. cross-organization isolation', () => {
    it('does not expose a need line to another organization, nor to the beneficiary', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });

      const mine = await call(U_EDIT,
        `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(mine).toBe(1);

      const other = await call(U_OTHER,
        `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(other).toBe(0);

      // A user of the BENEFICIARY institution sees nothing either: read is gated
      // on the owning organization, exactly as every other Central Needs policy.
      const beneficiaryUser = '00000000-0000-0000-0000-000000212406';
      await admin(`INSERT INTO auth.users (id,email) VALUES ($1,'p212-bene-user@rig')
                     ON CONFLICT (id) DO NOTHING`, [beneficiaryUser]);
      await admin(`UPDATE profiles SET role='institution_admin', status='active', organization_id=$1 WHERE id=$2`,
        [ORG_BENE, beneficiaryUser]);
      for (const k of ['view', 'edit']) {
        await admin(
          `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
             ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`,
          [beneficiaryUser, `central_needs.${k}`]);
      }
      const asBeneficiary = await call(beneficiaryUser,
        `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(asBeneficiary).toBe(0);
    });

    it('does not expose the provenance links either', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const other = await call(U_OTHER,
        `SELECT count(*)::int AS result FROM central_needs_need_line_sources WHERE need_line_id=$1`,
        [r.need_line_id]);
      expect(other).toBe(0);
    });
  });
});
