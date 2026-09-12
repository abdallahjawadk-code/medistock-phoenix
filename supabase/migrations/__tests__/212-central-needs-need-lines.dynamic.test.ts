/**
 * CN-2B CONFORMANCE (212) — DYNAMIC suite against the canonical replayed chain.
 *
 * Proves the operational Annual Needs projection on a real PostgreSQL: schema
 * shape, the beneficiary/warehouse/unit/quantity contracts, authorization and
 * role boundaries, revision editability, the N source rows -> 1 need line
 * consolidation, the extended review blockers, and — the one that protects live
 * data — that an ALREADY-APPROVED revision is never retroactively invalidated.
 *
 * Fixtures are seeded through the rig's superuser connection, exactly as the
 * 209/203 dynamic suites do: this suite tests 212's own contract, not 210/211's
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
const WH_FOREIGN = '00000000-0000-0000-0000-000000212902'; // belongs to ORG_BENE2

const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};

const SET_NEED_LINE =
  'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb)';

run('CN-2B/212 operational need lines — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2010;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /** A draft revision with one completed session carrying one mapped row. */
  async function scenario(opts: { status?: string } = {}) {
    const y = year++;
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
    const entity = 'sheet:0:row:5';
    await admin(
      `INSERT INTO central_needs_source_records
         (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
       VALUES ($1,$2,1,$3,'quantity','{"value":120}'::jsonb)`,
      [sessionId, ORG_OWNER, entity]);
    await admin(
      `INSERT INTO central_needs_record_mappings
         (import_session_id, organization_id, target_entity, central_item_id, decision)
       VALUES ($1,$2,$3,$4,'mapped')`,
      [sessionId, ORG_OWNER, entity, ITEM_A]);
    return { planId, revId, sessionId, entity, year: y };
  }

  const links = (sessionId: string, ...entities: string[]) =>
    JSON.stringify(entities.map((e) => ({ importSessionId: sessionId, targetEntity: e })));

  const setLine = (
    userId: string,
    revId: string,
    o: Partial<{
      beneficiary: string; item: string; qty: string | number; reason: string;
      unit: string | null; state: string; warehouse: string | null; sourceUnit: string | null; links: string;
    }> = {},
  ) => call(userId,
    `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result`,
    [revId, o.beneficiary ?? ORG_BENE, o.item ?? ITEM_A, 'qty' in o ? o.qty : 100, o.reason ?? 'mapped by reviewer',
      o.unit === undefined ? 'box' : o.unit, o.state ?? 'canonical', o.warehouse ?? null,
      o.sourceUnit ?? null, o.links ?? '[]']);

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
        ('${WH_FOREIGN}','${ORG_BENE2}','OTHER WH','مخزن اخر','active')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`UPDATE organizations SET status='inactive' WHERE id='${ORG_INACTIVE}'`);
    });
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // ---- SCHEMA ------------------------------------------------------------
  describe('A. schema', () => {
    it('creates both relations with RLS enabled and forced', async () => {
      const rows = await admin(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('central_needs_need_lines','central_needs_need_line_sources')
          ORDER BY relname`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.relrowsecurity, r.relname).toBe(true);
        expect(r.relforcerowsecurity, r.relname).toBe(true);
      }
    });

    it('stores approved_quantity as exact numeric(20,3), never a float', async () => {
      const [col] = await admin(
        `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_name='central_needs_need_lines' AND column_name='approved_quantity'`);
      expect(col.data_type).toBe('numeric');
      expect(col.numeric_precision).toBe(20);
      expect(col.numeric_scale).toBe(3);
    });

    it('keys the canonical line on revision + beneficiary + item, excluding warehouse', async () => {
      const defs = (await admin(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
          WHERE conrelid='public.central_needs_need_lines'::regclass AND contype='u'`)).map((r: any) => r.d);
      expect(defs).toContain('UNIQUE (plan_revision_id, beneficiary_organization_id, central_item_id)');
      expect(defs.join(' ')).not.toContain('target_warehouse_id');
    });

    it('lets one source row feed at most one need line', async () => {
      const defs = (await admin(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
          WHERE conrelid='public.central_needs_need_line_sources'::regclass AND contype='u'`)).map((r: any) => r.d);
      expect(defs).toContain('UNIQUE (import_session_id, target_entity)');
    });

    it('grants authenticated SELECT only — no direct write path', async () => {
      const rows = await admin(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee='authenticated' AND table_schema='public'
            AND table_name IN ('central_needs_need_lines','central_needs_need_line_sources')`);
      const privs = new Set(rows.map((r: any) => r.privilege_type));
      expect(privs.has('SELECT')).toBe(true);
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) expect(privs.has(p)).toBe(false);
    });

    it('pins search_path on every function it defines', async () => {
      const rows = await admin(
        `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN
            ('phoenix_central_needs_set_need_line','_phoenix_central_needs_assert_beneficiary_v1',
             '_phoenix_central_needs_review_blockers_v1')`);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const r of rows) expect(r.proconfig, r.proname).toContain('search_path=public, pg_temp');
    });
  });

  // ---- QUANTITY / UNIT ---------------------------------------------------
  describe('B. quantity and unit contract', () => {
    it('accepts zero as a valid approved quantity', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { qty: 0, links: links(s.sessionId, s.entity) });
      expect(r.ok).toBe(true);
      const [row] = await admin(`SELECT approved_quantity FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(Number(row.approved_quantity)).toBe(0);
    });

    it('preserves exact decimal quantities without rounding', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { qty: '120.125', links: links(s.sessionId, s.entity) });
      const [row] = await admin(`SELECT approved_quantity::text q FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(row.q).toBe('120.125');
    });

    it('rejects a negative quantity', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { qty: -1, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/approved_quantity_must_not_be_negative/);
    });

    it('rejects a missing quantity — blank is not zero', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { qty: null as any, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/approved_quantity_required/);
    });

    it('rejects a unit outside the canonical central_items vocabulary', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { unit: 'crate', links: links(s.sessionId, s.entity) }))
        .rejects.toThrow();
    });

    it('requires a canonical unit when the state is canonical', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { unit: null, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/canonical_unit_required/);
    });

    it('refuses a guessed conversion: conversion_required must carry no unit', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId,
        { state: 'conversion_required', unit: 'box', links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/conversion_required_must_not_carry_unit/);
    });

    it('accepts conversion_required with no unit and keeps the source unit as evidence', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: null, sourceUnit: 'علبة كبيرة',
        links: links(s.sessionId, s.entity),
      });
      expect(r.ok).toBe(true);
      const [row] = await admin(
        `SELECT approved_unit, unit_conversion_state, source_unit_text
           FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.approved_unit).toBeNull();
      expect(row.unit_conversion_state).toBe('conversion_required');
      expect(row.source_unit_text).toBe('علبة كبيرة');
    });
  });

  // ---- BENEFICIARY / WAREHOUSE ------------------------------------------
  describe('C. beneficiary and target warehouse', () => {
    it('persists the beneficiary as a dimension distinct from the owning org', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) });
      const [row] = await admin(
        `SELECT organization_id, beneficiary_organization_id FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(row.organization_id).toBe(ORG_OWNER);
      expect(row.beneficiary_organization_id).toBe(ORG_BENE);
      expect(row.organization_id).not.toBe(row.beneficiary_organization_id);
    });

    it('refuses a beneficiary that is not a care institution', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId,
        { beneficiary: ORG_AUTHORITY, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/beneficiary_must_be_care_institution/);
    });

    it('refuses an inactive beneficiary', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId,
        { beneficiary: ORG_INACTIVE, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/beneficiary_organization_not_active/);
    });

    it('treats target_warehouse_id as optional (institution-level need)', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { warehouse: null, links: links(s.sessionId, s.entity) });
      const [row] = await admin(`SELECT target_warehouse_id FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(row.target_warehouse_id).toBeNull();
    });

    it('accepts a warehouse owned by the beneficiary', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, links: links(s.sessionId, s.entity) });
      const [row] = await admin(`SELECT target_warehouse_id FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(row.target_warehouse_id).toBe(WH_BENE);
    });

    it('refuses a warehouse belonging to another organization', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { warehouse: WH_FOREIGN, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/target_warehouse_not_owned_by_beneficiary/);
    });
  });

  // ---- AUTHORIZATION ----------------------------------------------------
  describe('D. authorization', () => {
    it('allows a central warehouse manager holding central_needs.edit', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) });
      expect(r.ok).toBe(true);
    });

    it('denies a user in the owning org holding no central_needs key', async () => {
      const s = await scenario();
      await expect(setLine(U_NOPERM, s.revId, { links: links(s.sessionId, s.entity) })).rejects.toThrow();
    });

    it('denies a user from a different organization', async () => {
      const s = await scenario();
      await expect(setLine(U_OTHER, s.revId, { links: links(s.sessionId, s.entity) })).rejects.toThrow();
    });

    it('denies institution_admin and outlet_officer even holding every key', async () => {
      const s = await scenario();
      for (const u of [U_INST, U_OUTLET]) {
        await expect(setLine(u, s.revId, { links: links(s.sessionId, s.entity) }), u).rejects.toThrow();
      }
    });

    it('keeps the internal beneficiary helper off the client surface', async () => {
      const [row] = await admin(
        `SELECT has_function_privilege('authenticated',
            'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)','EXECUTE') AS can`);
      expect(row.can).toBe(false);
    });

    it('denies anon execution of the write primitive', async () => {
      const [row] = await admin(
        `SELECT has_function_privilege('anon','${SET_NEED_LINE}','EXECUTE') AS can`);
      expect(row.can).toBe(false);
    });

    it('refuses a direct authenticated INSERT into the need-line table', async () => {
      const s = await scenario();
      await expect(call(U_EDIT,
        `INSERT INTO public.central_needs_need_lines
           (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
            approved_quantity, approved_unit, mapping_reason)
         VALUES ($1,$2,$3,$4,1,'box','direct') RETURNING id AS result`,
        [s.revId, ORG_OWNER, ORG_BENE, ITEM_A])).rejects.toThrow();
    });
  });

  // ---- REVISION LIFECYCLE ----------------------------------------------
  describe('E. revision lifecycle', () => {
    it('refuses mapping on a non-draft revision', async () => {
      const s = await scenario({ status: 'submitted' });
      await expect(setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/plan_revision_not_editable/);
    });

    it('NEVER retroactively invalidates an already-approved revision', async () => {
      // The live 2026 case: a revision approved before 212 exists, with zero
      // need lines. 212's blockers must not be able to reach back into it.
      const s = await scenario({ status: 'draft' });
      await admin(
        `UPDATE central_needs_plan_revisions
            SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`,
        [s.revId, U_EDIT]);

      const [row] = await admin(
        `SELECT status, approved_at IS NOT NULL AS has_stamp
           FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(row.status).toBe('approved');
      expect(row.has_stamp).toBe(true);

      // Mapping is refused (history is not mutated in place) ...
      await expect(setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/plan_revision_not_editable/);
      // ... and the approval itself is untouched.
      const [after] = await admin(
        `SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(after.status).toBe('approved');
      const [{ n }] = await admin(
        `SELECT count(*)::int n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(0);
    });
  });

  // ---- CONSOLIDATION ---------------------------------------------------
  describe('F. source consolidation', () => {
    it('folds many source rows into one canonical line, auditably', async () => {
      const s = await scenario();
      const second = 'sheet:0:row:9';
      await admin(
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
         VALUES ($1,$2,2,$3,'quantity','{"value":30}'::jsonb)`,
        [s.sessionId, ORG_OWNER, second]);
      await admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision)
         VALUES ($1,$2,$3,$4,'mapped')`,
        [s.sessionId, ORG_OWNER, second, ITEM_A]);

      const r = await setLine(U_EDIT, s.revId, { qty: 150, links: links(s.sessionId, s.entity, second) });
      expect(r.source_link_count).toBe(2);
      const rows = await admin(
        `SELECT target_entity FROM central_needs_need_line_sources WHERE need_line_id=$1 ORDER BY target_entity`,
        [r.need_line_id]);
      expect(rows.map((x: any) => x.target_entity)).toEqual([s.entity, second]);
      // Source evidence itself is untouched by the consolidation.
      const [{ n }] = await admin(
        `SELECT count(*)::int n FROM central_needs_source_records WHERE import_session_id=$1`, [s.sessionId]);
      expect(n).toBe(2);
    });

    it('refuses to let one source row feed a second need line', async () => {
      const s = await scenario();
      await setLine(U_EDIT, s.revId, { item: ITEM_A, links: links(s.sessionId, s.entity) });
      await expect(setLine(U_EDIT, s.revId, { item: ITEM_B, links: links(s.sessionId, s.entity) }))
        .rejects.toThrow();
    });

    it('refuses a source link whose row was dispositioned not_applicable', async () => {
      const s = await scenario();
      const na = 'sheet:0:row:99';
      await admin(
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
         VALUES ($1,$2,3,$3,'note','{"value":"subtotal"}'::jsonb)`,
        [s.sessionId, ORG_OWNER, na]);
      await admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,$3,NULL,'not_applicable','subtotal row')`,
        [s.sessionId, ORG_OWNER, na]);
      await expect(setLine(U_EDIT, s.revId, { links: links(s.sessionId, na) }))
        .rejects.toThrow(/source_link_requires_mapped_disposition/);
    });

    it('refuses a source link from a session in another revision', async () => {
      const a = await scenario();
      const b = await scenario();
      await expect(setLine(U_EDIT, a.revId, { links: links(b.sessionId, b.entity) }))
        .rejects.toThrow(/source_link_session_not_in_revision/);
    });

    it('re-mapping the same scope updates in place rather than duplicating', async () => {
      const s = await scenario();
      const first = await setLine(U_EDIT, s.revId, { qty: 10, links: links(s.sessionId, s.entity) });
      const again = await setLine(U_EDIT, s.revId, { qty: 25, links: links(s.sessionId, s.entity) });
      expect(again.need_line_id).toBe(first.need_line_id);
      const [{ n }] = await admin(
        `SELECT count(*)::int n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(n).toBe(1);
      const [row] = await admin(
        `SELECT approved_quantity::text q FROM central_needs_need_lines WHERE id=$1`, [first.need_line_id]);
      expect(row.q).toBe('25.000');
    });
  });

  // ---- REVIEW BLOCKERS -------------------------------------------------
  describe('G. extended review blockers', () => {
    it('preserves every pre-212 blocker branch', async () => {
      const src = (await admin(
        `SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='_phoenix_central_needs_review_blockers_v1'`))[0].d;
      for (const b of ['no_finalized_import', 'import_session_still_open',
        'completed_session_not_in_trusted_batch', 'incomplete_trusted_batch',
        'target_entity_without_disposition']) {
        expect(src, b).toContain(b);
      }
    });

    it('blocks a mapped row that no need line claims', async () => {
      const s = await scenario();
      const list = (await blockers(s.revId)).map((b: any) => b.blocker);
      expect(list).toContain('mapped_target_entity_without_need_line');
    });

    it('clears that blocker once the row is mapped to a need line', async () => {
      const s = await scenario();
      await setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) });
      const list = (await blockers(s.revId)).map((b: any) => b.blocker);
      expect(list).not.toContain('mapped_target_entity_without_need_line');
    });

    it('blocks while any need line still needs a unit conversion', async () => {
      const s = await scenario();
      await setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: null, links: links(s.sessionId, s.entity),
      });
      const list = (await blockers(s.revId)).map((b: any) => b.blocker);
      expect(list).toContain('need_line_unit_conversion_required');
    });

    it('blocks an ineligible beneficiary that bypassed the write RPC (defence in depth)', async () => {
      // The RPC refuses a non-care_institution beneficiary, and the M201/M202
      // organization-archive guard refuses to deactivate an organization a need
      // line references (the new FK is a real dependency). So the only way such
      // a row can exist is a direct privileged write — precisely what branch 9
      // is there to catch.
      const s = await scenario();
      await admin(
        `INSERT INTO central_needs_need_lines
           (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
            approved_quantity, approved_unit, mapping_reason)
         VALUES ($1,$2,$3,$4,5,'box','direct privileged write')`,
        [s.revId, ORG_OWNER, ORG_AUTHORITY, ITEM_A]);
      const list = (await blockers(s.revId)).map((b: any) => b.blocker);
      expect(list).toContain('need_line_beneficiary_ineligible');
    });
  });

  // ---- AUDIT -----------------------------------------------------------
  describe('H. audit', () => {
    it('writes one attributable audit row per need-line write', async () => {
      const s = await scenario();
      const r = await setLine(U_EDIT, s.revId, { qty: 77, reason: 'reviewer designated the final block', links: links(s.sessionId, s.entity) });
      const rows = await admin(
        `SELECT actor_id, action, entity_type, entity_id, payload FROM audit_logs
          WHERE action='central_needs.need_line.set' AND entity_id=$1`, [r.need_line_id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(U_EDIT);
      expect(rows[0].entity_type).toBe('central_needs_need_line');
      expect(rows[0].payload.beneficiary_organization_id).toBe(ORG_BENE);
      expect(rows[0].payload.mapping_reason).toBe('reviewer designated the final block');
    });

    it('requires a mapping reason', async () => {
      const s = await scenario();
      await expect(setLine(U_EDIT, s.revId, { reason: '   ', links: links(s.sessionId, s.entity) }))
        .rejects.toThrow(/mapping_reason_required/);
    });
  });

  // ---- CROSS-ORG READ --------------------------------------------------
  describe('I. cross-organization isolation', () => {
    it('does not expose a need line to another organization through RLS', async () => {
      const s = await scenario();
      await setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) });
      const seen = await call(U_OTHER,
        `SELECT count(*)::int AS result FROM public.central_needs_need_lines WHERE plan_revision_id=$1`,
        [s.revId]);
      expect(Number(seen)).toBe(0);
    });

    it('does not expose it to the beneficiary institution either', async () => {
      // The beneficiary is named on the line but gains no read access to the
      // central plan (v7.3 section 1).
      const s = await scenario();
      await setLine(U_EDIT, s.revId, { links: links(s.sessionId, s.entity) });
      const [row] = await admin(
        `SELECT count(*)::int n FROM pg_policies
          WHERE tablename='central_needs_need_lines'
            AND qual LIKE '%beneficiary_organization_id%'`);
      expect(row.n).toBe(0);
    });
  });
});
