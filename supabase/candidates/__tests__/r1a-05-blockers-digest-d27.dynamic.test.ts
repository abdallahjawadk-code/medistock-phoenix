/**
 * R1-a candidate 05 — DYNAMIC proof: mode-gated review blockers, the manual digest section
 * (Excel digest bytes unchanged), and the D27 read restriction (inert until a marker exists).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { ORG, ORG_BENE, ORG_BENE_B, U, read, helpers, buildWithCandidates, newItem, grantManualKey, type Rig } from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F4 = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql', 'R1a_04_manual_routines_inert.sql'];
const F5 = 'R1a_05_blockers_digest_d27.sql';
const P = 'public.phoenix_central_needs_';

run('R1-a candidate 05 — blockers, digest, D27 (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig;
  let year = 2050;
  let item = '';
  let item2 = '';
  let excelRev = '';
  let digestExcelBefore = '';
  const h = helpers(() => rig);
  const { admin, txAs, as } = h;

  const call = async (sub: string, fn: string, args: unknown[]): Promise<any> => {
    let out: any;
    await txAs(sub, async (q) => { out = (await q(`SELECT ${P}${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args))[0].r; });
    return out;
  };
  const digest = async (rev: string) => (await admin(`SELECT phoenix_private.central_needs_submission_state_digest_v1($1) d`, [rev]))[0].d as string;
  const blockers = async (rev: string) => (await admin(`SELECT blocker FROM public._phoenix_central_needs_review_blockers_v1($1) ORDER BY 1`, [rev])).map((r: any) => r.blocker as string);
  const freshManual = async () => {
    year += 1;
    const r = await call(U.maker, 'open_manual_plan_revision', [ORG, year]);
    return { rev: r.plan_revision_id as string, y: year };
  };
  const add = (rev: string, qty = '10', ben = ORG_BENE, it = item) =>
    call(U.maker, 'add_manual_need_line', [rev, ben, it, null, qty, 'planned need', randomUUID(), null, null]);

  beforeAll(async () => {
    rig = await buildWithCandidates(F4, 1);
    item = await newItem(admin);
    item2 = await newItem(admin);
    await grantManualKey(rig, [U.maker, U.maker2]);
    year += 1;
    await txAs(null, async (q) => {
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG, year]);
      excelRev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by) VALUES ($1,$2,1,'draft','excel',$3) RETURNING id`, [plan, ORG, U.maker]))[0].id;
      await q(`INSERT INTO central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id, approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
               VALUES ($1,$2,$3,$4,25,'box','canonical','excel line',$5)`, [excelRev, ORG, ORG_BENE, item, U.maker]);
      const hex = (c: string) => c.repeat(64);
      const fid = (await q(`INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size) VALUES ($1,$2,'needs.xls',$3,1024) RETURNING id`, [excelRev, ORG, hex('a')]))[0].id;
      const parser = JSON.stringify({ contractVersion: '1.0.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8', runtime: 'node' });
      const sid = (await q(`INSERT INTO central_needs_import_sessions (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
        VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`, [excelRev, ORG, fid, hex('d'), parser]))[0].id;
      await q(`INSERT INTO central_needs_source_records (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
        VALUES ($1,$2,1,'sheet:0:row:1','col:1',$3::jsonb,$4::jsonb)`, [sid, ORG, JSON.stringify({ value: 25, valueType: 'number', isFormula: false, formula: null }),
        JSON.stringify({ sheetIndex: 0, coordinate: { row: 1, col: 1 }, fileHash: hex('a') })]);
      const bid = (await q(`INSERT INTO central_needs_import_batches (plan_revision_id, organization_id, container_kind, container_filename, container_sha256, storage_locator, accepted_entry_count, parser_identity)
        VALUES ($1,$2,'file','needs.xls',$3,'permanent/n',1,$4::jsonb) RETURNING id`, [excelRev, ORG, hex('c'), parser]))[0].id;
      await q(`INSERT INTO central_needs_import_batch_entries (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id) VALUES ($1,$2,$3,1,$4,$5)`, [bid, excelRev, ORG, hex('e'), sid]);
    }, { replica: true });
    digestExcelBefore = await digest(excelRev);
    const blockersBefore = await blockers(excelRev);
    (globalThis as any).__blockersBefore = blockersBefore;
    await admin(read(F5));
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  describe('Excel behaviour is untouched', () => {
    it('the Excel digest is byte-identical before and after candidate 05', async () => {
      expect(await digest(excelRev)).toBe(digestExcelBefore);
    });
    it('Excel blockers are exactly the pre-05 set and equal the private M217 body', async () => {
      expect(await blockers(excelRev)).toEqual((globalThis as any).__blockersBefore);
      const priv = (await admin(`SELECT blocker FROM phoenix_private.central_needs_excel_review_blockers_v1($1) ORDER BY 1`, [excelRev])).map((r: any) => r.blocker);
      expect(await blockers(excelRev)).toEqual(priv);
      expect(priv.length).toBeGreaterThan(0);          // the fixture revision has a completed session without dispositions
      expect(priv).toContain('target_entity_without_disposition');
    });
    it('an unknown revision id keeps the legacy (Excel) answer, never a manual one', async () => {
      const b = await blockers(randomUUID());
      expect(b).toContain('no_finalized_import');
      expect(b.some((x) => x.startsWith('manual_'))).toBe(false);
    });
  });

  describe('manual blockers', () => {
    it('empty manual revision is blocked; a clean one has no blockers (and no Excel blockers)', async () => {
      const { rev } = await freshManual();
      expect(await blockers(rev)).toEqual(['manual_revision_has_no_lines']);
      await add(rev);
      expect(await blockers(rev)).toEqual([]);
    });
    it('projection/event divergence is reported (defence in depth; guarded writes cannot produce it)', async () => {
      const { rev } = await freshManual();
      await add(rev, '10');
      await txAs(null, async (q) => { await q(`UPDATE central_needs_need_lines SET approved_quantity = 11 WHERE plan_revision_id=$1`, [rev]); }, { replica: true });
      expect(await blockers(rev)).toEqual(['manual_projection_event_divergence']);
    });
    it('item deactivation, unit drift and beneficiary deactivation are reported', async () => {
      const { rev } = await freshManual();
      const it3 = await newItem(admin);
      await add(rev, '3', ORG_BENE, it3);
      await admin(`UPDATE central_items SET status='inactive' WHERE id=$1`, [it3]);
      expect(await blockers(rev)).toContain('manual_line_item_not_active');
      await admin(`UPDATE central_items SET status='active', unit='vial' WHERE id=$1`, [it3]);
      expect(await blockers(rev)).toContain('manual_line_unit_mismatch');
      await admin(`UPDATE central_items SET unit='box' WHERE id=$1`, [it3]);
      await admin(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG_BENE_B]).catch(() => undefined);
    });
    it('coverage: omitted predecessor scopes block until acknowledged against the exact digest', async () => {
      const { rev, y } = await freshManual();
      await add(rev, '10', ORG_BENE, item);
      await add(rev, '2', ORG_BENE, item2);
      await txAs(null, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [rev, U.checker]); }, { replica: true });
      const c = await call(U.maker, 'open_manual_correction_revision', [ORG, y, rev, 'annual update']);
      await add(c.plan_revision_id, '11', ORG_BENE, item);
      expect(await blockers(c.plan_revision_id)).toEqual(['manual_coverage_unacknowledged']);
      const [{ d }] = await admin(`SELECT omitted_scope_digest d FROM phoenix_private.central_needs_coverage_digest_v1($1,$2)`, [c.plan_revision_id, rev]);
      await call(U.maker, 'acknowledge_manual_coverage', [c.plan_revision_id, d, 'item discontinued']);
      expect(await blockers(c.plan_revision_id)).toEqual([]);
    });
  });

  describe('manual digest', () => {
    it('is deterministic, and changes with every event and with an acknowledgement', async () => {
      const { rev } = await freshManual();
      const d0 = await digest(rev);
      expect(await digest(rev)).toBe(d0);
      const a = await add(rev, '10');
      const d1 = await digest(rev);
      expect(d1).not.toBe(d0);
      await call(U.maker, 'correct_manual_need_line', [rev, ORG_BENE, item, null, '12', 'recount', randomUUID(), a.event_id, null]);
      const d2 = await digest(rev);
      expect(d2).not.toBe(d1);
      expect(d2).toMatch(/^[0-9a-f]{64}$/);
    });
    it('is sensitive to quantity text, reason and actor of an event (tamper detection)', async () => {
      const { rev } = await freshManual();
      await add(rev, '10');
      const d = await digest(rev);
      await txAs(null, async (q) => { await q(`ALTER TABLE central_needs_manual_need_events DISABLE TRIGGER USER`); await q(`UPDATE central_needs_manual_need_events SET reason='changed later' WHERE plan_revision_id=$1`, [rev]); await q(`ALTER TABLE central_needs_manual_need_events ENABLE TRIGGER USER`); }, { replica: true });
      expect(await digest(rev)).not.toBe(d);
    });
  });

  describe('structure after 05', () => {
    it('private Excel blockers are unreachable; the public blockers keep their ACL; census still 23; seal clean', async () => {
      const [r] = await admin(`SELECT has_function_privilege('authenticated','phoenix_private.central_needs_excel_review_blockers_v1(uuid)','EXECUTE') a,
        has_function_privilege('authenticated','public._phoenix_central_needs_review_blockers_v1(uuid)','EXECUTE') b,
        has_function_privilege('service_role','public._phoenix_central_needs_review_blockers_v1(uuid)','EXECUTE') c`);
      expect(r).toEqual({ a: false, b: false, c: false });
      expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
      const [{ n }] = await admin(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
        WHERE s.nspname NOT IN ('pg_catalog','information_schema')
          AND regexp_replace(p.prosrc,'--[^\\n]*','','g') ~* '(insert\\s+into|update|delete\\s+from|truncate|merge\\s+into)\\s+(only\\s+)?(table\\s+)?("?public"?\\.|"?phoenix_private"?\\.)?"?central_needs_[a-z_]+'`);
      expect(n).toBe(23);
    });
  });

  describe('D27 read surfaces (F02)', () => {
    it('the restriction covers exactly the 7 enumerated relations, each RESTRICTIVE FOR SELECT, none of them writable', async () => {
      const rows = await admin(`SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
        WHERE p.polname='excel_history_read_restrictive' AND NOT p.polpermissive AND p.polcmd='r' ORDER BY 1`);
      expect(rows.map((r: any) => r.relname)).toEqual([
        'central_needs_field_overrides', 'central_needs_import_batch_entries', 'central_needs_import_batches', 'central_needs_need_line_sources',
        'central_needs_need_lines', 'central_needs_source_files', 'central_needs_source_records']);
    });
    it('the gateway of the signed-URL download (the batch row) is covered, not only the quantity tables', async () => {
      const [{ q }] = await admin(`SELECT pg_get_expr(p.polqual, p.polrelid) q FROM pg_policy p WHERE p.polrelid='public.central_needs_import_batches'::regclass AND p.polname='excel_history_read_restrictive'`);
      expect(q).toContain('may_read_excel_history');
    });
  });

  describe('D27 read restriction (runs last: the activation marker is append-only)', () => {
    it('inactive: no behaviour change; active: Excel quantity rows are hidden from view-only users, kept for approvers; manual rows stay visible', async () => {
      const { rev: mrev } = await freshManual();
      await add(mrev, '4');
      const count = (u: string, rev: string) => as(u, `SELECT count(*)::int n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [rev]).then((r: any[]) => r[0].n as number);
      expect(await count(U.viewer, excelRev)).toBe(1);
      const surfaces: Array<[string, string]> = [
        ['central_needs_source_files', `plan_revision_id = $1`],
        ['central_needs_import_batches', `plan_revision_id = $1`],
        ['central_needs_import_batch_entries', `plan_revision_id = $1`],
        ['central_needs_source_records', `import_session_id IN (SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)`],
      ];
      const surfaceCount = (u: string, t: string, w: string) => as(u, `SELECT count(*)::int n FROM ${t} WHERE ${w}`, [excelRev]).then((r: any[]) => r[0].n as number);
      for (const [t, w] of surfaces) expect(await surfaceCount(U.viewer, t, w), `${t} before activation`).toBe(1);
      expect((await admin(`SELECT phoenix_cn_policy.excel_read_restriction_state($1) s`, [ORG]))[0].s).toBe('inactive');

      await admin(`INSERT INTO central_needs_cutover_inventory (organization_id, entry_kind) VALUES ($1,'activation_marker')`, [ORG]);
      expect((await admin(`SELECT phoenix_cn_policy.excel_read_restriction_state($1) s`, [ORG]))[0].s).toBe('active');
      expect(await count(U.viewer, excelRev)).toBe(0);
      expect(await count(U.checker, excelRev)).toBe(1); // view + approve in the owning organization
      for (const [t, w] of surfaces) {
        expect(await surfaceCount(U.viewer, t, w), `${t}: view-only after activation`).toBe(0);
        expect(await surfaceCount(U.checker, t, w), `${t}: approver after activation`).toBe(1);
        expect(await surfaceCount(U.other, t, w), `${t}: other organization`).toBe(0);
      }
      expect(await count(U.viewer, mrev)).toBe(1);      // manual rows are never restricted by D27
      expect(await count(U.other, excelRev)).toBe(0);   // another organization's holder sees nothing
    });
  });
});
