/**
 * M182 equivalence - TOKEN-AWARE (static) and BEHAVIOURAL (dynamic) proof that the Production-recorded function bodies (the 182b overlay) are the
 * same function as the repository's M182 bodies. Disposable rig only. A = frozen M182 untouched; B = M182 + 182b overlay; C = B with a deliberate
 * one-token mutation (negative control: the matrix MUST see it).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';
import { buildBaseline, OVERLAY_182B } from '../staging-baseline/staging-baseline.mjs';
import { compareSqlTokens, tokenizeSql } from '../staging-baseline/sql-tokens.mjs';

const FREEZE = JSON.parse(readFileSync(join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), 'utf8'));
const ATT = { ownerRef: 'TEST-ONLY synthetic attestation on a disposable rig (not an Owner attestation)', evidenceSha256: 'f'.repeat(64) };
const M182 = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('182_'))!;
const bodyOf = (text: string, sig: string) => { const a = text.indexOf(sig); const o = text.indexOf('AS $function$', a); const e = text.indexOf('$function$;', o); return text.slice(o + 13, e); };
const SIGS = ['CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)', 'CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(p_profile_id uuid, p_key text)'];

describe('M182 equivalence - token-aware (no database)', () => {
  const orig = readFileSync(join(MIGRATIONS_DIR, M182), 'utf8'); const ov = readFileSync(OVERLAY_182B, 'utf8');
  it('both Production-recorded bodies are token-identical to the repository bodies', () => {
    for (const sig of SIGS) { const r = compareSqlTokens(bodyOf(orig, sig), bodyOf(ov, sig)); expect(r.equal, JSON.stringify(r.firstDifference)).toBe(true); expect(r.count).toBeGreaterThan(60); }
  });
  it('the tokenizer is NOT a whitespace stripper: it separates a b from ab, keeps literal case, quoted identifiers and comments out', () => {
    expect(compareSqlTokens('select a b', 'select ab').equal).toBe(false);
    expect(compareSqlTokens("select 'x'", "select 'X'").equal).toBe(false);
    expect(compareSqlTokens('select "Id"', 'select id').equal).toBe(false);
    expect(compareSqlTokens('SELECT a /* c */ FROM t -- z', 'select a\nfrom t').equal).toBe(true);
    expect(compareSqlTokens('v:=1', 'v := 1').equal).toBe(true);
    expect(compareSqlTokens('a<>b', 'a < > b').equal).toBe(false);
    expect(compareSqlTokens("x := $q$it's$q$", "x := $q$it's$q$").equal).toBe(true);
    expect(tokenizeSql('select 1 -- only comment').length).toBe(2);
  });
  it('one changed token in a real body is detected', () => {
    const b = bodyOf(ov, SIGS[1]); expect(compareSqlTokens(b, b.replace('THEN false', 'THEN true')).equal).toBe(false);
  });
});

const run = rigAvailable() ? describe : describe.skip;
run('M182 equivalence - behavioural matrix on the rig (PG)', { timeout: 900_000 }, () => {
  const ORG1 = '00000000-0000-0000-0000-0000000c5101', ORG2 = '00000000-0000-0000-0000-0000000c5102', ORG3 = '00000000-0000-0000-0000-0000000c5103';
  const USERS = [['sa', 'super_admin', ORG1], ['cwm1', 'central_warehouse_manager', ORG1], ['cwm1b', 'central_warehouse_manager', ORG1], ['cwm2', 'central_warehouse_manager', ORG2],
    ['inst1', 'institution_admin', ORG1], ['hcm1', 'health_center_manager', ORG3], ['hcm1b', 'health_center_manager', ORG3], ['cwm3', 'central_warehouse_manager', ORG3]] as const;
  const id = (n: number) => `00000000-0000-0000-0000-0000000c52${String(n).padStart(2, '0')}`;
  const ids = USERS.map((_, i) => id(i + 1));
  const NONE = id(99);

  async function seed(c: any) {
    await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES ($1,'E1','E1','eq-1','care_institution','hospital'),($2,'E2','E2','eq-2','care_institution','hospital'),($3,'E3','E3','eq-3','care_institution','health_sector')`, [ORG1, ORG2, ORG3]);
    await c.query(`INSERT INTO auth.users (id, email) SELECT x, 'eq-'||substr(x::text,35)||'@rig' FROM unnest($1::uuid[]) x`, [ids]);
    for (let i = 0; i < USERS.length; i++) await c.query(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`, [ids[i], USERS[i][1], USERS[i][2]]);
    const keys = (await c.query(`SELECT key FROM permission_keys ORDER BY key`)).rows.map((r: any) => r.key as string);
    await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true),($1,$3,false),($4,$2,false),($5,$3,true)`, [ids[1], keys[0], keys[1], ids[4], ids[5]]);
    return keys;
  }
  async function matrix(c: any, keys: string[]) {
    const sample = keys.filter((_, i) => i % Math.max(1, Math.floor(keys.length / 14)) === 0).slice(0, 14).concat(['nonexistent.key']);
    const out: Record<string, unknown> = {};
    const actors: Array<string | null> = [...ids, '', null];   // '' = authenticated role WITHOUT a subject (auth.uid() is null); null = anon role
    const targets = [...ids, NONE];
    for (const a of actors) {
      await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${a !== null ? 'authenticated' : 'anon'}`);
      if (a !== null) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [a]);
      for (const t of targets) {
        try { out[`gep|${a}|${t}`] = (await c.query(`SELECT public.get_effective_permissions($1) r`, [t])).rows[0].r; } catch (e: any) { out[`gep|${a}|${t}`] = 'ERR:' + e.code; await c.query('ROLLBACK'); await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${a !== null ? 'authenticated' : 'anon'}`); if (a !== null) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [a]); }
        for (const k of sample) {
          try { out[`hp|${a}|${t}|${k}`] = (await c.query(`SELECT public.phoenix_profile_has_permission($1,$2) r`, [t, k])).rows[0].r; } catch (e: any) { out[`hp|${a}|${t}|${k}`] = 'ERR:' + e.code; await c.query('ROLLBACK'); await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${a !== null ? 'authenticated' : 'anon'}`); if (a !== null) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [a]); }
        }
      }
      await c.query('ROLLBACK');
    }
    return out;
  }
  const build = async (overlay: boolean) => buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, overlay182: overlay, upTo: 182, useDiskBytes: true });

  it('A (repository M182 bodies) and B (Production-recorded bodies) return IDENTICAL results for every actor x target x key; a one-token mutation (C) is detected', async () => {
    const a = await build(false); const keys = await seed(a.client); const mA = await matrix(a.client, keys); await a.client.end();
    const b = await build(true); await seed(b.client); const mB = await matrix(b.client, keys);
    const ov = readFileSync(OVERLAY_182B, 'utf8');
    const stmt = ov.slice(ov.indexOf(SIGS[1]), ov.indexOf('$function$;', ov.indexOf(SIGS[1])) + '$function$;'.length);
    expect(stmt).toContain('THEN false');
    await b.client.query(stmt.replace('THEN false', 'THEN true'));
    const mC = await matrix(b.client, keys); await b.client.end();
    const total = Object.keys(mA).length;
    expect(total).toBeGreaterThan(1000);
    const diffAB = Object.keys(mA).filter((k) => JSON.stringify(mA[k]) !== JSON.stringify(mB[k]));
    expect(diffAB, `A/B differences: ${diffAB.slice(0, 5).join(', ')}`).toEqual([]);
    // non-vacuity: the matrix exercises every branch of the two functions
    const vals = Object.values(mA).map((v) => JSON.stringify(v));
    for (const needle of ['NOT_AUTHENTICATED', 'TARGET_NOT_FOUND', 'OUT_OF_SCOPE', '"ok":true']) expect(vals.some((v) => v.includes(needle)), needle).toBe(true);
    expect(Object.keys(mA).some((k) => k.startsWith('hp|') && mA[k] === true)).toBe(true);
    expect(Object.keys(mA).some((k) => k.startsWith('hp|') && mA[k] === false)).toBe(true);
    const diffAC = Object.keys(mA).filter((k) => JSON.stringify(mA[k]) !== JSON.stringify(mC[k]));
    expect(diffAC.length, 'the negative control must be visible to the matrix').toBeGreaterThan(0);
    console.log(`M182_MATRIX total=${total} A_B_diff=0 A_C_diff=${diffAC.length}`);
  });
});
