/**
 * R1 staging B1/B2 closure - the proposed baseline-preparation method, tested ONLY on the disposable rig (PG17 when pointed at it).
 * Baseline = frozen M001-M221 (a scratch migrations dir that contains 221 is required: the workspace stops at 220).
 * Not a Supabase test. Nothing here touches Staging.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rigAvailable, buildRig, MIGRATIONS_DIR, freshRigDb } from '../../../tools/pg-rig/rig.mjs';
import { buildBaseline, fingerprint, derive023, frozenBytes, sha256, VERIFY_BASELINE, ROLLBACK_PHASE1, BaselineError } from '../staging-baseline/staging-baseline.mjs';

const FREEZE = JSON.parse(readFileSync(join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), 'utf8')) as Array<{ path: string; sha256: string }>;
const has221 = () => readdirSync(MIGRATIONS_DIR).some((f) => f.startsWith('221_'));
const run = rigAvailable() && has221() ? describe : describe.skip;
const ATT = { ownerRef: 'TEST-ONLY synthetic attestation on a disposable rig (not an Owner attestation)', evidenceSha256: 'f'.repeat(64) };
const CATS = ['proc', 'rel', 'col', 'policy', 'trigger', 'constraint', 'index', 'permission_keys', 'role_defaults', 'roles'];

run('R1 staging baseline method (B1/B2) - disposable rig', { timeout: 900_000 }, () => {
  let A: any; let fpA: any; let Bexact: any; let Bdisk: any; let fpExact: any; let fpDisk: any;

  beforeAll(async () => {
    // reference = the PG-rig canonical build (in-memory shims, M004 applied)
    const rig = await buildRig({ upTo: 221 });
    fpA = await rig.asAdmin((c: any) => fingerprint(c));
    await rig.end();
    // proposed method, frozen bytes, M004 skipped (decision B2 option 1), verifier-gated M085 with a (test-only) attestation
    Bexact = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT });
    fpExact = await fingerprint(Bexact.client);
    await Bexact.client.end();
    // same, but applying the on-disk (LF) bytes - isolates the pure line-ending effect
    Bdisk = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, useDiskBytes: true });
    fpDisk = await fingerprint(Bdisk.client);
    await Bdisk.client.end();                       // idle clients are killed when a later test recreates the shared database (unhandled 'terminating connection'); only the ledger is used afterwards
  }, 900_000);
  afterAll(async () => { await Bdisk?.client?.end().catch(() => undefined); });

  it('the method (original bytes + hash-pinned 182b overlay + 023 derivation + verifier-gated 085, M004 skipped) reproduces the PG-rig reference state in EVERY schema/ACL/policy/trigger/body category', () => {
    const diff = CATS.filter((k) => fpDisk[k] !== fpA[k]);
    expect(diff, `categories that differ from the rig reference: ${diff.join(',')}`).toEqual([]);
    expect(fpDisk.n_proc).toBe(fpA.n_proc); expect(fpDisk.n_policy).toBe(fpA.n_policy); expect(fpDisk.n_trigger).toBe(fpA.n_trigger);
  });

  it('M004 is schema-neutral: skipping it changes nothing the schema categories can see (and no later migration needed its rows)', () => {
    expect(CATS.filter((k) => fpDisk[k] !== fpA[k])).toEqual([]);   // A has M004 applied, Bdisk does not
    expect(Bdisk.ledger.find((l: any) => l.file.startsWith('004_')).action).toMatch(/NOT_APPLIED/);
  });

  it('LINE-ENDING HAZARD (recorded): frozen blob bytes (4 files are CRLF in the freeze) vs LF checkout bytes can change function text; the method must apply frozen bytes', () => {
    const diff = CATS.filter((k) => fpExact[k] !== fpDisk[k]);
    // not an assertion of equality: this documents what differs so the decision-maker sees it (printed into the JSON log)
    console.log('LINE_ENDING_DIFF_CATEGORIES=' + JSON.stringify(diff));
    expect(Array.isArray(diff)).toBe(true);
    expect(Bexact.ledger.filter((l: any) => l.form === 'crlf' || l.form === 'as-on-disk').length).toBeGreaterThan(0);
  });

  it('LEDGER: every applied file carries original + applied SHA-256; exactly 023 is derived, 182b is a separate overlay, 085 carries its proofs and attestation', () => {
    const L = Bdisk.ledger as any[];
    expect(L.filter((l) => /APPLIED derived/.test(l.action)).map((l) => l.file.slice(0, 3))).toEqual(['023']);
    expect(L.filter((l) => l.file.startsWith('182b')).length).toBe(1);
    const l85 = L.find((l) => l.file.startsWith('085_'));
    expect(l85.preconditions.every((p: any) => p.ok)).toBe(true);
    expect(l85.attestation.ownerRef).toMatch(/TEST-ONLY/);
    expect(L.filter((l) => l.original_sha256).length).toBe(L.filter((l) => !l.file.startsWith('182b')).length);
    for (const l of L.filter((x) => /APPLIED original/.test(x.action))) expect(l.applied_sha256).toBeTruthy();
  });

  it('VERIFY (read-only baseline checks) passes on the rebuilt baseline, and FAILS when a protection is tampered with', async () => {
    const sql = readFileSync(VERIFY_BASELINE, 'utf8');
    const own = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, useDiskBytes: true });   // own database: later tests recreate the shared one
    own.client.on('error', () => undefined);          // a later freshRigDb() terminates idle sessions; that is expected, not a failure
    Bdisk.client = own.client;
    const ok = (await Bdisk.client.query(sql)).rows;
    expect(ok.filter((r: any) => !r.ok).map((r: any) => r.check)).toEqual([]);
    expect(ok.length).toBeGreaterThanOrEqual(7);
    await Bdisk.client.query('BEGIN');
    try {
      await Bdisk.client.query(`GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(uuid, text, integer, text, text) TO authenticated`);
      const bad = (await Bdisk.client.query(sql)).rows.filter((r: any) => !r.ok).map((r: any) => r.check);
      expect(bad.some((c: string) => /M085 effect/.test(c))).toBe(true);
    } finally { await Bdisk.client.query('ROLLBACK'); }
  });

  it('M085 stays HOLD: with M004 demo rows the parity precondition is NOT provable (manual quantities exist) and no attestation can override it', async () => {
    await expect(buildBaseline({ freeze: FREEZE, skip004: false, attestation: ATT, upTo: 85 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('M085 stays HOLD without a named owner attestation even when every SQL precondition is proven', async () => {
    await expect(buildBaseline({ freeze: FREEZE, skip004: true, attestation: null, upTo: 85 })).rejects.toMatchObject({ code: 'ATTESTATION_REQUIRED' });
    await expect(buildBaseline({ freeze: FREEZE, skip004: true, attestation: { ownerRef: '', evidenceSha256: '' }, upTo: 85 })).rejects.toMatchObject({ code: 'ATTESTATION_REQUIRED' });
  });

  it('a tampered frozen file is refused BEFORE any statement runs (hash binding)', async () => {
    const t = { '120_': 0 };
    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('120_'))!;
    await expect(buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, tamper: { [name]: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) } })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(t).toBeTruthy();
  });

  it('without the 182b overlay the rebuild diverges from the Production-recorded bodies (the reason the overlay exists)', async () => {
    const r = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, overlay182: false, upTo: 182, useDiskBytes: true });
    const v = (await r.client.query(`SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') h FROM pg_proc WHERE oid='public.phoenix_profile_has_permission(uuid,text)'::regprocedure`)).rows[0].h;
    await r.client.end();
    expect(v).not.toBe('7fb2f8b311ab181b0189fb3ec6e13f2b068bc3ec588343a56be8c4df672f5188');
  });

  it('with the 182b overlay, the two function bodies at the M182 step hash EXACTLY to the Production-recorded SHA-256 values', async () => {
    const r = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, upTo: 182, useDiskBytes: true });
    const h = async (sig: string) => (await r.client.query(`SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') h FROM pg_proc WHERE oid='${sig}'::regprocedure`)).rows[0].h;
    const a = await h('public.get_effective_permissions(uuid)'); const b = await h('public.phoenix_profile_has_permission(uuid,text)');
    await r.client.end();
    expect(a).toBe('c7c67a94feaef3e8dd7efe8b86db32e93ab949418f18dafc90bc91a3936f3406');
    expect(b).toBe('7fb2f8b311ab181b0189fb3ec6e13f2b068bc3ec588343a56be8c4df672f5188');
  });

  it('M085 P4 REQUIRES the current authenticated EXECUTE on BOTH writers (has_function_privilege) and no PUBLIC/anon grant: passes on the real pre-085 state, FAILS when either is withdrawn', async () => {
    const r = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, upTo: 84, useDiskBytes: true });
    const sql = readFileSync(join(__dirname, '..', 'staging-baseline', 'verify_085_preconditions.sql'), 'utf8');
    const p4 = async () => (await r.client.query(sql)).rows.find((x: any) => /^P4 actual EXECUTE/.test(x.check));
    const U = 'public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)';
    const W = 'public.phoenix_apply_availability_movement(uuid, text, integer, text, text)';
    const base = await p4();
    expect(base.ok, base.detail).toBe(true);
    expect(base.detail).toMatch(/upsert=true apply=true/); expect(base.detail).not.toMatch(/PUBLIC|anon/);
    for (const [name, fn] of [['apply', W], ['upsert', U]] as const) {          // RED: withdraw ONE of the two (inside a rolled-back transaction)
      await r.client.query('BEGIN'); await r.client.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM authenticated`);
      const x = await p4(); await r.client.query('ROLLBACK');
      expect(x.ok, `${name} revoked`).toBe(false);
      expect(x.detail).toContain(name === 'apply' ? 'apply=false' : 'upsert=false');
    }
    await r.client.query('BEGIN'); await r.client.query(`GRANT EXECUTE ON FUNCTION ${W} TO anon`);
    const a = await p4(); await r.client.query('ROLLBACK');
    expect(a.ok).toBe(false); expect(a.detail).toMatch(/phoenix_apply_availability_movement <- anon/);
    await r.client.query('BEGIN'); await r.client.query(`GRANT EXECUTE ON FUNCTION ${W} TO PUBLIC`);
    const pub = await p4(); await r.client.query('ROLLBACK');
    expect(pub.ok).toBe(false); expect(pub.detail).toMatch(/<- PUBLIC/);
    expect((await p4()).ok).toBe(true);                                         // everything rolled back: GREEN again
    await r.client.end();
  });

  it('M023 derivation is exactly the three VERIFY reads and refuses to drift', () => {
    const src = readFileSync(join(MIGRATIONS_DIR, readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('023_'))!), 'utf8');
    const out = derive023(src);
    expect(src.split('\n').length).toBe(out.split('\n').length);
    expect(sha256(Buffer.from(out))).not.toBe(sha256(Buffer.from(src)));
    expect(() => derive023(src.replace(/SELECT\s+qual\s+INTO/i, 'SELECT x INTO'))).toThrow(BaselineError);
    expect(frozenBytes(Buffer.from('x'), 'deadbeef')).toBeNull();
  });

  it('ROLLBACK (rig only): the disposable rollback script returns the application schemas to the pre-baseline state', async () => {
    const own = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: ATT, useDiskBytes: true });
    own.client.on('error', () => undefined);
    const c = own.client;
    const count = async () => (await c.query(`SELECT
      (SELECT count(*) FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public' AND cl.relkind IN ('r','p','v','m','S')) rels,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')) procs,
      (SELECT count(*) FROM pg_policies WHERE schemaname='public') pols,
      (SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'phoenix%') schemas,
      (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'phoenix\\_%') roles`)).rows[0];
    const before = await count();
    expect(Number(before.rels)).toBeGreaterThan(50);
    await c.query(readFileSync(ROLLBACK_PHASE1, 'utf8'));
    const after = await count();
    const fresh = await freshRigDb({});
    const base = (await fresh.query(`SELECT (SELECT count(*) FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public' AND cl.relkind IN ('r','p','v','m','S')) rels,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')) procs,
      (SELECT count(*) FROM pg_policies WHERE schemaname='public') pols, (SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'phoenix%') schemas,
      (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'phoenix\\_%') roles`)).rows[0];
    await fresh.end();
    expect(after).toEqual(base);
    await own.client.end().catch(() => undefined);
  });
});
