/**
 * M228-EXTENSION-SCHEMA — DYNAMIC regression (real disposable PostgreSQL) for the NUMBERED M228 file read from disk.
 *
 * Production installs pg_trgm in schema `extensions`, so public.similarity(text, text) does not exist there; the disposable
 * rig and a fresh baseline install it in `public` (M001 creates it without a schema). The frozen original M228 hard-coded
 * public.similarity inside phoenix_private.central_material_candidates_v1 and its Production apply failed with SQLSTATE
 * 42883 (run 39935101242, FAILED_CLEAN). The repaired M228 binds the call to the schema of the INSTALLED pg_trgm extension,
 * accepting only a similarity(text, text) -> real that is a registered member of pg_trgm in pg_trgm's own schema.
 *
 * Every placement replays the canonical chain to M227, shapes the extension placement, then applies the real numbered M228:
 *   - HOSTED (pg_trgm 1.6 relocated to `extensions`, attested: no public.similarity): M228 applies, binds to
 *     extensions.similarity, keeps search_path = pg_catalog, pg_temp and the owner-only ACL, and the routine behaves.
 *   - HOSTED + decoys: a same-name public.similarity(text, text) that is NOT a pg_trgm member (it returns 1.0) cannot be
 *     bound; with the member's extension membership removed, or with pg_trgm absent, M228 refuses before it creates anything.
 *   - LEGACY (pg_trgm in `public`, a decoy extensions.similarity present): M228 applies, binds to public.similarity, and the
 *     created body equals the original public-qualified body.
 * Behaviour (each placement): an exact identity is STRONG; similar names are ADVISORY at >= 0.45 through BOTH the name and the
 * name_ar branch; unrelated items are never returned; anon, authenticated and service_role cannot execute the routine.
 *
 * Replacing ONLY the numbered M228 with the frozen original (blob 3ad86b61...) turns the HOSTED placement red with 42883.
 * Synthetic catalog rows only. Gated on PHOENIX_RIG_PG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const M228_FILE = '228_phoenix_central_needs_material_registration_inert.sql';
const M228 = readFileSync(join(__dirname, '..', M228_FILE), 'utf8').replace(/\r\n/g, '\n');
const CANDIDATES = 'phoenix_private.central_material_candidates_v1(text, text, text, text, text)';
const M228_TABLES = ['central_needs_material_requests', 'central_needs_material_request_events', 'central_needs_material_request_links'];

type Rig = Awaited<ReturnType<typeof buildRig>>;
type Placement = 'hosted' | 'legacy';

interface Refusal { code: string; message: string }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: String(err.code), message: String(err.message) };
  }
  throw new Error('expected the database to refuse this, but it succeeded');
}

async function sql(rig: Rig, text: string, params: unknown[] = []) {
  return rig.asAdmin(async (c) => (await c.query(text, params)).rows);
}

/** M227 pre-state with pg_trgm placed as on Production (`extensions`) or as on the fresh baseline (`public`). */
async function m227With(placement: Placement): Promise<Rig> {
  const rig = await buildRig({ upTo: 227 });
  if (placement === 'hosted') {
    await sql(rig, 'CREATE SCHEMA extensions');
    await sql(rig, 'ALTER EXTENSION pg_trgm SET SCHEMA extensions');
  }
  return rig;
}

async function trgm(rig: Rig) {
  const [row] = await sql(rig, `
    SELECT e.extversion AS version, n.nspname AS schema,
           to_regprocedure('public.similarity(text,text)') IS NOT NULL AS public_similarity,
           to_regprocedure('extensions.similarity(text,text)') IS NOT NULL AS extensions_similarity,
           to_regclass('public.central_needs_material_requests') IS NOT NULL AS m228_present
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'`);
  return row;
}

async function applyM228(rig: Rig) {
  await rig.asAdmin(async (c) => { await c.query(M228); });
}

async function candidatesRoutine(rig: Rig) {
  const [row] = await sql(rig, `
    SELECT p.prosrc AS src, p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text AS acl,
           pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p WHERE p.oid = '${CANDIDATES}'::regprocedure`);
  return row as { src: string; secdef: boolean; config: string[]; acl: string | null; owner: string };
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

/** Synthetic catalog fixture (unique per call) and the routine's verdict on it. */
async function behaviour(rig: Rig) {
  const tag = randomUUID().slice(0, 8);
  const sci = `Ciprofloxacin Hydrochloride ${tag}`;
  const item = async (name: string, nameAr: string, o: { conc?: string; form?: string; unit?: string } = {}) => {
    const id = randomUUID();
    await sql(rig, `INSERT INTO central_items (id, name, name_ar, unit, status, concentration, dosage_form, barcode)
                    VALUES ($1,$2,$3,$4,'active',$5,$6,NULL)`, [id, name, nameAr, o.unit ?? 'box', o.conc ?? null, o.form ?? null]);
    return id;
  };
  const exact = await item(sci, `سيبروفلوكساسين ${tag}`, { conc: '500 mg', form: 'Tablet' });
  const byName = await item(`${sci} Tabs`, `اسم عربي مختلف ${tag}`, { conc: '250 mg', form: 'Tablet' });
  const byNameAr = await item(`Unrelated Latin Label ${tag}`, sci, { conc: '250 mg', form: 'Tablet' });
  const unrelated = await item(`Zz Qq Unrelated ${randomUUID()}`, `غير ذي صلة ${randomUUID()}`, { conc: '1 g', form: 'Syrup' });
  const rows = await sql(rig, `SELECT central_item_id::text AS id, grade, score FROM phoenix_private.central_material_candidates_v1($1,$2,$3,$4,NULL)`,
    [sci, '500 mg', 'Tablet', 'box']);
  const of = (id: string) => rows.filter((r) => r.id === id);
  return { rows, exact: of(exact), byName: of(byName), byNameAr: of(byNameAr), unrelated: of(unrelated) };
}

async function apiRoleCanExecute(rig: Rig) {
  return sql(rig, `SELECT r AS role, has_function_privilege(r, '${CANDIDATES}', 'EXECUTE') AS can
                     FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
}

/** The real roles are refused at call time, not only by the catalog privilege bit. */
async function apiRoleCallRefused(rig: Rig, role: string) {
  return refusal(rig.asUser(null, async (c) => c.query(`SELECT * FROM ${CANDIDATES.replace(/\(.*$/, '')}('a','b','c','box',NULL)`), { role }));
}

function expectBehaviour(b: Awaited<ReturnType<typeof behaviour>>) {
  expect(b.exact).toEqual([{ id: b.exact[0]?.id, grade: 'strong', score: 1 }]);
  expect(b.byName).toHaveLength(1);
  expect(b.byName[0].grade).toBe('advisory');
  expect(b.byName[0].score).toBeGreaterThanOrEqual(0.45);
  expect(b.byNameAr).toHaveLength(1);
  expect(b.byNameAr[0].grade).toBe('advisory');
  expect(b.byNameAr[0].score).toBeGreaterThanOrEqual(0.45);
  expect(b.unrelated).toEqual([]);
  for (const r of b.rows.filter((x) => x.grade === 'advisory')) expect(r.score).toBeGreaterThanOrEqual(0.45);
}

async function expectInertAndOwnerOnly(rig: Rig) {
  const r = await candidatesRoutine(rig);
  expect(r.secdef).toBe(true);
  expect(r.config).toEqual(['search_path=pg_catalog, pg_temp']);
  expect(r.src).toContain('a.s >= 0.45');
  expect(r.src).not.toMatch(/\bLIMIT\b/i);
  expect(await apiRoleCanExecute(rig)).toEqual([
    { role: 'anon', can: false }, { role: 'authenticated', can: false }, { role: 'service_role', can: false },
  ]);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const e = await apiRoleCallRefused(rig, role);
    expect(e.code).toBe('42501');
    expect(e.message).toMatch(/permission denied/);
  }
  const [inert] = await sql(rig, `
    SELECT (SELECT count(*)::int FROM public.central_needs_cutover_inventory WHERE entry_kind = 'activation_marker') AS markers,
           phoenix_cn_policy.excel_sod_enabled() AS excel_sod,
           (SELECT count(*)::int FROM public.permission_keys WHERE key = 'central_needs.material_review') AS review_key,
           (SELECT count(*)::int FROM public.role_permission_defaults WHERE permission_key = 'central_needs.material_review') AS review_defaults,
           (SELECT count(*)::int FROM public.profile_permission_overrides WHERE permission_key = 'central_needs.material_review') AS review_overrides,
           (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches`);
  expect(inert).toEqual({ markers: 0, excel_sod: false, review_key: 1, review_defaults: 0, review_overrides: 0, breaches: 0 });
}

run('M228-EXTENSION-SCHEMA — numbered M228 binds similarity() to the installed pg_trgm (dynamic, PostgreSQL)', { timeout: 600_000 }, () => {
  describe('HOSTED placement: pg_trgm in extensions, no public.similarity', () => {
    let rig: Rig;
    let before: Record<string, unknown>;
    beforeAll(async () => {
      rig = await m227With('hosted');
      before = await trgm(rig);
      await applyM228(rig);
    }, 600_000);
    afterAll(async () => { await rig?.end(); });

    it('the fixture is Production-shaped immediately before the apply (attested, not assumed)', () => {
      expect(before).toEqual({ version: '1.6', schema: 'extensions', public_similarity: false, extensions_similarity: true, m228_present: false });
    });

    it('the numbered M228 applies and binds BOTH trigram calls to extensions.similarity', async () => {
      expect((await trgm(rig)).m228_present).toBe(true);
      const { src } = await candidatesRoutine(rig);
      expect(count(src, 'extensions.similarity(')).toBe(2);
      expect(count(src, 'similarity(')).toBe(2);
      expect(src).not.toContain('public.similarity(');
      for (const t of M228_TABLES) expect((await sql(rig, `SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`]))[0].ok).toBe(true);
      expect((await trgm(rig)).public_similarity).toBe(false);   // green without any public shim
    });

    it('behaviour: exact identity is strong; name and name_ar similarity are advisory at >= 0.45; unrelated items are excluded', async () => {
      expectBehaviour(await behaviour(rig));
    });

    it('trust boundary unchanged: pinned search_path, owner-only EXECUTE (real API roles refused), still inert', async () => {
      await expectInertAndOwnerOnly(rig);
    });
  });

  describe('HOSTED placement with decoys: only the pg_trgm member can be bound; otherwise M228 refuses', () => {
    let rig: Rig;
    beforeAll(async () => {
      rig = await m227With('hosted');
      // A same-name decoy that is NOT a pg_trgm member and would accept every catalog item if it were bound.
      await sql(rig, `CREATE FUNCTION public.similarity(text, text) RETURNS real LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0::real $$`);
    }, 600_000);
    afterAll(async () => { await rig?.end(); });

    const refusedInside = async (prepare: string) => rig.asAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(prepare);
        return await refusal(c.query(M228));
      } finally {
        await c.query('ROLLBACK');
      }
    });

    it('with the member removed from pg_trgm (function still present, decoy in public), M228 refuses before creating anything', async () => {
      const e = await refusedInside('ALTER EXTENSION pg_trgm DROP FUNCTION extensions.similarity(text, text)');
      expect(e.message).toBe('R1a06_precondition_failed: pg_trgm (schema extensions) must provide exactly one member similarity(text, text) returning real, found 0');
      expect((await trgm(rig)).m228_present).toBe(false);
    });

    it('with pg_trgm absent, M228 refuses before creating anything', async () => {
      const e = await refusedInside('DROP EXTENSION pg_trgm CASCADE');
      expect(e.message).toBe('R1a06_precondition_failed: the pg_trgm extension is not installed');
      expect(await trgm(rig)).toMatchObject({ version: '1.6', schema: 'extensions', m228_present: false });
    });

    it('with the decoy present, M228 applies bound to extensions.similarity, never to the decoy', async () => {
      expect(await trgm(rig)).toMatchObject({ schema: 'extensions', public_similarity: true, m228_present: false });
      await applyM228(rig);
      const { src } = await candidatesRoutine(rig);
      expect(count(src, 'extensions.similarity(')).toBe(2);
      expect(src).not.toContain('public.similarity(');
      const b = await behaviour(rig);
      expectBehaviour(b);   // the decoy (1.0 for everything) would have returned the unrelated item
      expect(b.byName[0].score).toBeLessThan(1);
    });
  });

  describe('LEGACY placement: pg_trgm in public (fresh baseline / disposable rig), decoy extensions.similarity present', () => {
    let rig: Rig;
    let before: Record<string, unknown>;
    beforeAll(async () => {
      rig = await m227With('legacy');
      await sql(rig, 'CREATE SCHEMA extensions');
      await sql(rig, `CREATE FUNCTION extensions.similarity(text, text) RETURNS real LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0::real $$`);
      before = await trgm(rig);
      await applyM228(rig);
    }, 600_000);
    afterAll(async () => { await rig?.end(); });

    it('the fixture keeps pg_trgm in public', () => {
      expect(before).toEqual({ version: '1.6', schema: 'public', public_similarity: true, extensions_similarity: true, m228_present: false });
    });

    it('M228 applies bound to public.similarity, and the created body is the original public-qualified body', async () => {
      const { src } = await candidatesRoutine(rig);
      expect(count(src, 'public.similarity(')).toBe(2);
      expect(src).not.toContain('extensions.similarity(');
      const template = M228.slice(M228.indexOf('AS $$', M228.indexOf('EXECUTE pg_catalog.format($sql$')) + 'AS $$'.length, M228.indexOf('$$\n$sql$, v_schema);'));
      expect(template.split('%1$I.similarity(').length - 1).toBe(2);
      expect(src).toBe(template.split('%1$I.similarity(').join('public.similarity('));
    });

    it('behaviour: exact identity is strong; name and name_ar similarity are advisory at >= 0.45; unrelated items are excluded', async () => {
      expectBehaviour(await behaviour(rig));
    });

    it('trust boundary unchanged: pinned search_path, owner-only EXECUTE (real API roles refused), still inert', async () => {
      await expectInertAndOwnerOnly(rig);
    });
  });
});
