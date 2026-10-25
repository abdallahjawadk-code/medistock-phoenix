/**
 * M231-UNIT-TEST-VOCABULARY — DYNAMIC regression (real disposable PostgreSQL) for the NUMBERED M231 file read from disk.
 *
 * R1-UNIT-TEST-01: the owner's 2026 acceptance draft is a screening reagent dosed in `test` units. The historical
 * eight-unit vocabulary is enforced by three CHECK constraints — central_items.unit (M001), central_needs_need_lines
 * .approved_unit (M212), central_needs_material_requests.unit (M228) — and M231 widens exactly those three,
 * append-only, 'test' last, inside a single transaction with fail-closed PRE and VERIFY blocks that pin the FULL
 * pg_get_constraintdef text RAW — no case-folding, no whitespace stripping, no cast-stripping: those rewrite quoted
 * literals as well as SQL structure (no word-presence test; `OR true` and extra conjuncts are drift too; a changed
 * literal — case, trailing space, ::text inside the string — is drift as well). The migration carries
 * NO data probes — every execution probe below lives here, on the throwaway rig only.
 *
 * Coverage, in order, on ONE canonical rig build (001..230):
 *   1. BASELINE: the catalog CHECK refuses 'test' with 23514, and all three definitions equal the pinned originals.
 *   2. PRE DRIFT MATRIX (F2) on the PRE-EXPANSION baseline: every tamper DDL succeeds first, then the numbered M231
 *      itself refuses with M231_precondition_failed — extra unit, `OR true`, extra conjunct, lost historical unit,
 *      three literal-content drifts ('VIAL', 'vial ', 'vial::text' — eight units each, which the broken v2
 *      normalization would have equated with the original), partial application (already admits 'test'), and a
 *      NOT VALID constraint — and every refusal leaves all three definitions and the witness row exactly as before.
 *   3. APPLY: the numbered M231 file applies; definitions equal the pinned nine-unit forms (9 literals each);
 *      approved_unit keeps its M212 NULL semantics; the F1 witness row (a pre-existing catalog item literally named
 *      'M231 probe') is untouched; the M226 capability seal is clean.
 *   4. REGISTRATION FLOW (F4), two real identities: an ordinary maker (view+edit+manual_need.set) creates a draft
 *      with unit 'test', reads it back, submits; a DIFFERENT ordinary reviewer (view+approve+material_review) starts
 *      the review and approves — the new central_items row carries unit 'test'; the maker then enters the owner's
 *      acceptance-shaped need (quantity text '11520') through the M226 writer and the line lands with
 *      approved_unit='test'; the revision is submitted by the maker and approved by the reviewer (SoD).
 *   5. EXECUTION PROBES on all three constraints (rolled-back transactions): 'carton' refused with 23514 everywhere;
 *      'test' accepted on central_items and central_needs_need_lines; the historical eight still accepted.
 *   6. NEGATIVES (F4): self-review refused (separation_of_duties); a call under the authenticated role with empty
 *      auth.uid (NOT the anon role) gets 28000; a member of another PDA is refused by the membership guard; a staffed
 *      but NOT-activated PDA is refused by the M229/M230 manual-activation guard; a draft with unit 'carton' is
 *      refused by the table CHECK through the RPC path.
 *   7. DOUBLE-APPLY: re-applying M231 refuses in PRE (fail-closed idempotence).
 *
 * Synthetic identities and catalog rows only; quantity 11520 appears as TEXT in fixtures, never a Production write.
 * Gated on PHOENIX_RIG_PG. Nothing here ever touches Production.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore — untyped .mjs rig helper, same import pattern as the 224 dynamic test
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const M231_FILE = '231_phoenix_unit_test_vocabulary.sql';
const M231 = readFileSync(join(__dirname, '..', M231_FILE), 'utf8').replace(/\r\n/g, '\n');

const HEAD_EIGHT = ['box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other'] as const;
const NINE = [...HEAD_EIGHT, 'test'] as const;

// RAW pg_get_constraintdef renderings — no case-folding, no whitespace stripping,
// no cast-stripping: those rewrite quoted literals as well as SQL structure and
// would equate different unit values ('VIAL' = 'vial', 'vial ' = 'vial',
// 'vial::text' inside a literal = 'vial'). PRE/VERIFY compare against these
// texts verbatim.
const LIST_RAW = (units: readonly string[]) => units.map((u) => `'${u}'::text`).join(', ');
const unitCheck = (units: readonly string[]) => `CHECK ((unit = ANY (ARRAY[${LIST_RAW(units)}])))`;
const linesCheck = (units: readonly string[]) =>
  `CHECK (((approved_unit IS NULL) OR (approved_unit = ANY (ARRAY[${LIST_RAW(units)}]))))`;
const EXPECTED = {
  items8: unitCheck(HEAD_EIGHT),
  items9: unitCheck(NINE),
  lines8: linesCheck(HEAD_EIGHT),
  lines9: linesCheck(NINE),
  requests8: unitCheck(HEAD_EIGHT),
  requests9: unitCheck(NINE),
} as const;
// Live-DDL helper for tamper statements (values are stored lowercase).
const LIST_LO = (units: readonly string[]) => units.map((u) => `'${u}'`).join(',');

const DEFS_SQL = `
  SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def, c.convalidated
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
   WHERE ns.nspname = 'public' AND c.contype = 'c'
     AND ((t.relname = 'central_items' AND c.conname = 'central_items_unit_check')
       OR (t.relname = 'central_needs_need_lines' AND c.conname = 'central_needs_need_lines_unit_vocab_chk')
       OR (t.relname = 'central_needs_material_requests' AND c.conname = 'central_needs_material_requests_unit_chk'))`;

// Synthetic identities (the 224 fixture pattern: ordinary roles, explicit keys, no role class).
const ORG = '00000000-0000-0000-0000-00000000d541';        // PDA, activated
const ORG2 = '00000000-0000-0000-0000-00000000d542';       // PDA, staffed but NOT activated
const ORG_BENE = '00000000-0000-0000-0000-00000000d543';   // beneficiary hospital
const MAKER = '00000000-0000-0000-0000-00000000d581';      // ORG: view, edit, manual_need.set
const REVIEWER = '00000000-0000-0000-0000-00000000d582';   // ORG: view, approve, material_review
const MAKER2 = '00000000-0000-0000-0000-00000000d583';     // ORG2: view, edit, manual_need.set

const SCIENTIFIC = 'Screening test for HBS Ag (Elisa) test';
const WITNESS_NAME = 'M231 probe';
const WITNESS_BARCODE = 'M231-WITNESS';

interface Refusal { code: string; message: string; detail?: string }
async function refusalOf(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

run('M231 — unit vocabulary admits test (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  const as = (userId: string | null, sql: string, params: unknown[] = []) =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role: 'authenticated', commit: true });
  const one = async (user: string | null, sql: string, args: unknown[] = []) => (await as(user, sql, args))[0];
  const rpc = async (user: string | null, fn: string, args: unknown[]) =>
    (await one(user, `SELECT public.phoenix_central_needs_${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args)).r;
  const defs = async () => {
    const rows = await admin(DEFS_SQL);
    expect(rows).toHaveLength(3);
    return rows as Array<{ table_name: string; conname: string; def: string; convalidated: boolean }>;
  };
  const defsSnapshot = async () => (await defs()).map((r) => `${r.table_name}:${r.def}:${r.convalidated}`).sort();

  let flow: { revision: string; request: string; item: string } | null = null;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 230 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'R1U PDA','دائرة','r1u-owner','pharmacy_department_authority',NULL),
        ($2,'R1U Other PDA','دائرة أخرى','r1u-other','pharmacy_department_authority',NULL),
        ($3,'R1U Hospital','مستشفى','r1u-bene','care_institution','hospital')`,
        [ORG, ORG2, ORG_BENE]);
      await c.query(`INSERT INTO auth.users (id, email) SELECT x, 'r1u-'||substr(x::text,33)||'@rig' FROM unnest($1::uuid[]) x`,
        [[MAKER, REVIEWER, MAKER2]]);
      const set = (u: string, role: string, org: string) =>
        c.query(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`, [u, role, org]);
      await set(MAKER, 'warehouse_officer', ORG);
      await set(REVIEWER, 'warehouse_officer', ORG);
      await set(MAKER2, 'warehouse_officer', ORG2);
      const grants: Array<[string, string[]]> = [
        [MAKER, ['view', 'edit', 'manual_need.set']],
        [REVIEWER, ['view', 'approve', 'material_review']],
        [MAKER2, ['view', 'edit', 'manual_need.set']],
      ];
      for (const [u, keys] of grants) for (const k of keys) {
        await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
          ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [u, `central_needs.${k}`]);
      }
      // F1 witness: a PRE-EXISTING catalog row that happens to carry the old probe name.
      await c.query(`INSERT INTO central_items (name, name_ar, barcode, unit, status, description)
        VALUES ($1,'شاهد قديم',$2,'box','active','pre-existing witness row; M231 must never delete by name')`,
        [WITNESS_NAME, WITNESS_BARCODE]);
    });
    // Activate ORG only. ORG2 stays staffed-but-unactivated for the activation-guard negative.
    const [{ r }] = await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) AS r`, [ORG]);
    expect(r).toMatchObject({ ok: true, idempotent_replay: false });
  }, 900_000);
  afterAll(async () => { await rig?.end(); });

  it('PRE-M231 baseline: the catalog CHECK refuses the test unit, and all three definitions equal the pinned originals', async () => {
    await expect(
      admin(`INSERT INTO public.central_items (name, name_ar, unit) VALUES ('M231 gap probe','M231 gap probe','test')`),
    ).rejects.toMatchObject({ code: '23514' });
    const rows = await defs();
    const by = Object.fromEntries(rows.map((r) => [r.table_name, r.def]));
    expect(by.central_items).toBe(EXPECTED.items8);
    expect(by.central_needs_need_lines).toBe(EXPECTED.lines8);
    expect(by.central_needs_material_requests).toBe(EXPECTED.requests8);
    for (const row of rows) {
      expect(row.convalidated).toBe(true);
      expect((row.def.length - row.def.replace(/'/g, '').length) / 2).toBe(8);
    }
  });

  // The drift matrix runs on the PRE-EXPANSION baseline (before M231 is applied and
  // before any test-unit material exists). On this baseline every tamper DDL must
  // SUCCEED first — a refusal coming from PostgreSQL's own ADD CONSTRAINT validation
  // is NOT counted as proving M231's guard. The refusal must then come from
  // M231_precondition_failed itself. Literal-content drifts (case, trailing space,
  // ::text inside the literal) keep the list at exactly eight units: the broken
  // normalization of v2 (case-fold + strip whitespace + strip ::text over the whole
  // text) would have equated them with the pinned original; the raw comparison
  // refuses them. The M004 demo seed includes one 'vial' row, so the literal-replacement
  // tampers first move vial rows aside INSIDE the same rolled-back transaction — otherwise
  // PostgreSQL's own ADD CONSTRAINT validation (not M231) would refuse the tamper DDL.
  const CLEAR_VIAL = `UPDATE public.central_items SET unit='box' WHERE unit='vial'`;
  it('PRE drift matrix on the pre-expansion baseline: tamper DDL succeeds, M231 itself refuses, nothing changes', async () => {
    const tamper = (expr: string) => [
      `ALTER TABLE public.central_items DROP CONSTRAINT central_items_unit_check`,
      `ALTER TABLE public.central_items ADD CONSTRAINT central_items_unit_check CHECK (${expr})`,
    ];
    const cases: Array<[string, string[], RegExp, string?]> = [
      ['an extra unit in the list', tamper(`unit IN (${LIST_LO(HEAD_EIGHT)}, 'carton')`), /M231_precondition_failed[\s\S]*drifted/],
      ['an appended OR true', tamper(`unit IN (${LIST_LO(HEAD_EIGHT)}) OR true`), /M231_precondition_failed[\s\S]*drifted/],
      ['an extra conjunct', tamper(`unit IN (${LIST_LO(HEAD_EIGHT)}) AND length(unit) < 99`), /M231_precondition_failed[\s\S]*drifted/],
      ['a lost historical unit', tamper(`unit IN ('box','vial','ampoule','tablet','bottle','tube','other')`), /M231_precondition_failed[\s\S]*drifted/],
      ['a literal case drift (VIAL for vial, still eight units)',
        tamper(`unit IN ('box','VIAL','ampoule','tablet','bottle','tube','sachet','other')`), /M231_precondition_failed[\s\S]*drifted/, CLEAR_VIAL],
      ['a literal trailing space (vial-space, still eight units)',
        tamper(`unit IN ('box','vial ','ampoule','tablet','bottle','tube','sachet','other')`), /M231_precondition_failed[\s\S]*drifted/, CLEAR_VIAL],
      ['a literal ::text inside the literal (vial::text, still eight units)',
        tamper(`unit IN ('box','vial::text','ampoule','tablet','bottle','tube','sachet','other')`), /M231_precondition_failed[\s\S]*drifted/, CLEAR_VIAL],
      ['a partial application (already admits test)', tamper(`unit IN (${LIST_LO(NINE)})`), /M231_precondition_failed[\s\S]*already admits test/],
      ['a NOT VALID constraint', [...tamper(`unit IN (${LIST_LO(HEAD_EIGHT)})`).slice(0, 1),
        `ALTER TABLE public.central_items ADD CONSTRAINT central_items_unit_check CHECK (unit IN (${LIST_LO(HEAD_EIGHT)})) NOT VALID`],
        /M231_precondition_failed[\s\S]*NOT VALID/],
    ];
    for (const [label, ddls, match, pre] of cases) {
      const before = await defsSnapshot();
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          // Hard precondition: the tamper DDL itself must succeed on the baseline;
          // only then does an M231 refusal prove the guard, not the database.
          if (pre) await c.query(pre);
          for (const ddl of ddls) await c.query(ddl);
          await expect(c.query(M231), label).rejects.toThrow(match);
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(await defsSnapshot(), label).toEqual(before);
      const witness = await admin(`SELECT count(*)::int AS n FROM central_items WHERE barcode=$1`, [WITNESS_BARCODE]);
      expect(witness[0].n, label).toBe(1);
    }
  });

  it('applies the numbered M231: pinned nine-unit definitions, NULL semantics kept, F1 witness untouched, seal clean', async () => {
    await rig.asAdmin((c: any) => c.query(M231));
    const rows = await defs();
    const by = Object.fromEntries(rows.map((r) => [r.table_name, r.def]));
    expect(by.central_items).toBe(EXPECTED.items9);
    expect(by.central_needs_need_lines).toBe(EXPECTED.lines9);
    expect(by.central_needs_material_requests).toBe(EXPECTED.requests9);
    for (const row of rows) {
      expect(row.convalidated).toBe(true);
      expect((row.def.length - row.def.replace(/'/g, '').length) / 2).toBe(9);
    }
    expect(rows.find((r) => r.table_name === 'central_needs_need_lines')!.def.toUpperCase())
      .toContain('APPROVED_UNIT IS NULL');
    const witness = await admin(`SELECT name, barcode, unit, description FROM central_items WHERE barcode=$1`, [WITNESS_BARCODE]);
    expect(witness).toEqual([{ name: WITNESS_NAME, barcode: WITNESS_BARCODE, unit: 'box', description: 'pre-existing witness row; M231 must never delete by name' }]);
    expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
  });

  it('F4: maker creates a test-unit draft, a DIFFERENT reviewer approves it, and the catalog carries unit test', async () => {
    const opened = await rpc(MAKER, 'open_manual_plan_revision', [ORG, 2041]);
    expect(opened).toMatchObject({ ok: true });
    const revision = opened.plan_revision_id as string;

    const draft = await rpc(MAKER, 'create_material_request_draft',
      [ORG, SCIENTIFIC, 'فحص HBS Ag', null, null, null, 'test', null, null, 'manual_typed', '{}', revision, 'r1u-key-draft-01']);
    expect(draft).toMatchObject({ ok: true, idempotent_replay: false, status: 'draft', version: 1 });
    const request = draft.request_id as string;

    // The maker reads the governed capability projection: view+edit true, approve false.
    const caps = (await as(MAKER,
      `SELECT view, edit, approve, manual_set FROM public.phoenix_central_needs_my_capabilities($1)`, [ORG]))[0];
    expect(caps).toMatchObject({ view: true, edit: true, approve: false });
    const row = (await admin(`SELECT scientific_name, unit, status, version, requester_id FROM central_needs_material_requests WHERE id=$1`, [request]))[0];
    expect(row).toMatchObject({ scientific_name: SCIENTIFIC, unit: 'test', status: 'draft', version: 1, requester_id: MAKER });

    await rpc(MAKER, 'submit_material_request', [request, 1]);
    await rpc(REVIEWER, 'start_material_review', [request, 2]);
    // Acknowledge whatever advisory candidates exist so the human-confirmation gate passes.
    const advisory = (await admin(
      `SELECT central_item_id FROM phoenix_private.central_material_candidates_v1($1,$2,$3,$4,$5) WHERE grade='advisory'`,
      [SCIENTIFIC, null, null, 'test', null])).map((r: any) => r.central_item_id);
    const approved = await rpc(REVIEWER, 'approve_new_material', [request, 3, advisory, 'R1-UNIT-TEST-01 rig approval']);
    expect(approved).toMatchObject({ ok: true, status: 'approved_new' });

    const item = (await admin(`SELECT id, unit, status, created_by FROM central_items WHERE id=$1`, [approved.central_item_id]))[0];
    expect(item).toMatchObject({ unit: 'test', status: 'active', created_by: REVIEWER });
    flow = { revision, request, item: approved.central_item_id as string };
  });

  it('F4: the M226 manual intake accepts the new material with approved_unit=test and quantity text 11520', async () => {
    expect(flow).not.toBeNull();
    const added = await rpc(MAKER, 'add_manual_need_line',
      [flow!.revision, ORG_BENE, flow!.item, null, '11520', 'R1-UNIT-TEST-01 acceptance-shaped need', 'r1u-key-line-01', null, null]);
    expect(added).toMatchObject({ ok: true, event_kind: 'add' });
    const line = (await admin(
      `SELECT approved_unit, approved_quantity::text AS q, unit_conversion_state
         FROM central_needs_need_lines WHERE plan_revision_id=$1 AND central_item_id=$2`,
      [flow!.revision, flow!.item]))[0];
    expect(line).toMatchObject({ approved_unit: 'test', q: String(Number('11520')), unit_conversion_state: 'canonical' });
    // SoD on the revision itself: the maker submits, the DIFFERENT reviewer approves.
    await rpc(MAKER, 'submit_revision', [flow!.revision]);
    await rpc(REVIEWER, 'approve_revision', [flow!.revision]);
    const rev = (await admin(`SELECT status, approved_by FROM central_needs_plan_revisions WHERE id=$1`, [flow!.revision]))[0];
    expect(rev).toMatchObject({ status: 'approved', approved_by: REVIEWER });
  });

  it('execution probes (rolled back): carton refused on all three constraints; test and the historical eight accepted', async () => {
    expect(flow).not.toBeNull();
    // central_items: legacy eight accepted, test accepted, carton refused.
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        for (const u of HEAD_EIGHT) {
          await c.query(`INSERT INTO public.central_items (name, name_ar, unit) VALUES ('probe ${u}','probe','${u}')`);
        }
        await c.query(`INSERT INTO public.central_items (name, name_ar, unit) VALUES ('probe test','probe','test')`);
        await expect(c.query(`INSERT INTO public.central_items (name, name_ar, unit) VALUES ('probe carton','probe','carton')`))
          .rejects.toMatchObject({ code: '23514' });
      } finally {
        await c.query('ROLLBACK');
      }
      // need_lines: test accepted, carton refused, and the M212 pair check still enforces
      // approved_unit IS NULL <=> unit_conversion_state='conversion_required'.
      // The event-sourced projection guard (manual_projection_change_without_event) is
      // bypassed with SET LOCAL session_replication_role for this raw CHECK probe only;
      // everything runs inside a transaction that is rolled back.
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL session_replication_role = 'replica'`);
        const probeItem = (await c.query(
          `INSERT INTO public.central_items (name, name_ar, unit) VALUES ('R1U line probe','probe','box') RETURNING id`)).rows[0].id as string;
        await c.query(
          `INSERT INTO public.central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id, approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
           VALUES ($1,$2,$3,$4,11520,'test','canonical','R1U probe',$2)`, [flow!.revision, ORG, ORG_BENE, probeItem]);
        await expect(c.query(
          `INSERT INTO public.central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id, approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
           VALUES ($1,$2,$3,$4,1,'carton','canonical','R1U probe',$2)`, [flow!.revision, ORG, ORG_BENE, probeItem]))
          .rejects.toMatchObject({ code: '23514' });
      } finally {
        await c.query('ROLLBACK');
      }
      // material_requests: carton refused through the real RPC path (table CHECK), on top of the flow's test-unit draft.
      await expect(rpc(MAKER, 'create_material_request_draft',
        [ORG, 'Probe carton material', null, null, null, null, 'carton', null, null, 'manual_typed', '{}', null, 'r1u-key-carton-01']))
        .rejects.toMatchObject({ code: '23514' });
    });
  });

  it('F4 negatives: self-review, empty-uid authenticated call, cross-org membership, and the not-activated guard all refuse', async () => {
    // Self-review: with the reviewer key granted, the maker STILL may not review their own request (SoD).
    const draft = await rpc(MAKER, 'create_material_request_draft',
      [ORG, 'R1U second material', null, null, null, null, 'test', null, null, 'manual_typed', '{}', null, 'r1u-key-draft-02']);
    await rpc(MAKER, 'submit_material_request', [draft.request_id, 1]);
    await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.material_review',true)
      ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [MAKER]);
    try {
      const selfReview = await refusalOf(rpc(MAKER, 'start_material_review', [draft.request_id, 2]));
      expect(selfReview.message).toBe('central_needs_separation_of_duties_violation');
    } finally {
      await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.material_review',false)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=false`, [MAKER]);
    }
    // No identity: the call runs under the authenticated role with an empty
    // auth.uid() (NOT the anon role); the guard refuses with not_authenticated.
    expect((await refusalOf(rpc(null, 'create_material_request_draft',
      [ORG, 'R1U empty-uid material', null, null, null, null, 'test', null, null, 'manual_typed', '{}', null, 'r1u-key-anon-01']))).code).toBe('28000');
    // Cross-org: MAKER2 belongs to ORG2 and can never touch ORG's intake.
    expect((await refusalOf(rpc(MAKER2, 'create_material_request_draft',
      [ORG, 'R1U foreign material', null, null, null, null, 'test', null, null, 'manual_typed', '{}', null, 'r1u-key-foreign-01']))).message)
      .toBe('forbidden_central_needs');
    // Activation guard: ORG2 is staffed but NOT activated — its own maker is refused by the M229/M230 guard.
    expect((await refusalOf(rpc(MAKER2, 'create_material_request_draft',
      [ORG2, 'R1U org2 material', null, null, null, null, 'test', null, null, 'manual_typed', '{}', null, 'r1u-key-org2-01']))).message)
      .toBe('manual_intake_not_activated');
  });

  it('refuses a double application in PRE (fail-closed idempotence)', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await expect(c.query(M231)).rejects.toThrow(/already admits test/);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

});
