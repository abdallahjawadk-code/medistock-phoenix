// D24 isolated restore + verification. LOCAL ONLY: restores a pg_dump -Fc archive into a throw-away database of the LOCAL loopback PostgreSQL 17 cluster
// (PHOENIX_RIG_PG / PHOENIX_RIG_DB), proves the content fingerprint equals the one taken from the source, probes the copy for anything that could call out,
// and verifies the Storage copy against its manifest. It refuses to run unless the whole process environment is isolated (no hosted URL, no service-role key, no Production ref).
//   node tools/d24/restore-verify.mjs --dump <archive> --pg-bin <dir> --expected <fingerprint.json> --auth-ids <ids.json> --manifest <manifest.json> --storage-dir <folder> --evidence <out.json>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOUND_PROBE_SQL, assertRestoreIsolation, verifyStorageRestore } from './d24-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.slice(2); const val = (f) => { const i = arg.indexOf(f); return i >= 0 ? arg[i + 1] : undefined; };
const [dump, pgBin, expectedPath, idsPath, manifestPath, storageDir, evidencePath] = ['--dump', '--pg-bin', '--expected', '--auth-ids', '--manifest', '--storage-dir', '--evidence'].map(val);
if (![dump, pgBin, expectedPath, idsPath, manifestPath, storageDir, evidencePath].every(Boolean)) { console.error('usage: see header'); process.exit(2); }
const dbUrl = process.env.PHOENIX_RIG_PG ?? '';
const violations = assertRestoreIsolation({ env: process.env, databaseUrl: dbUrl, storageDir });
if (violations.length) { console.error('STOP-ISOLATION:\n- ' + violations.join('\n- ')); process.exit(3); }
const url = new URL(dbUrl);
const { freshRigDb } = await import(new URL('../pg-rig/rig.mjs', import.meta.url).href);
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const authIds = JSON.parse(readFileSync(idsPath, 'utf8'));
const fingerprintSql = readFileSync(join(HERE, 'd24-counts.sql'), 'utf8');
const ev = { restorable: false, stage: 'start', dump_sha256: createHash('sha256').update(readFileSync(dump)).digest('hex') };
const report = (code) => { writeFileSync(evidencePath, JSON.stringify(ev, null, 1)); console.log(JSON.stringify({ restorable: ev.restorable, stage: ev.stage, fingerprint_mismatches: ev.fingerprint_mismatches, outbound_findings: ev.outbound_findings, storage: ev.storage })); return code; };
async function run() {
const c = await freshRigDb({});
try {
  ev.stage = 'prerequisites';
  // platform prerequisites exist only in the throw-away database (NOT part of the archive). Auth users are stubs: id only, a non-routable placeholder address.
  for (const id of authIds) await c.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@restore.invalid`]);
  await c.query(`CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role`);
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF; END $$`);
  await c.query(`ALTER DATABASE ${c.database} SET search_path TO public, extensions`);
  ev.stage = 'pg_restore';
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PGPASSWORD: decodeURIComponent(url.password) };   // a minimal, clean environment
  const base = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
  const toc = spawnSync(`${pgBin}\\pg_restore.exe`, ['--list', dump], { encoding: 'utf8', env });
  const lines = String(toc.stdout).split('\n'); const kept = lines.filter((l) => !/^\d+; \d+ \d+ SCHEMA - public /.test(l));
  if (lines.length - kept.length !== 1) { ev.error = `expected to exclude exactly 1 TOC entry (SCHEMA public), excluded ${lines.length - kept.length}`; return report(1); }
  const listFile = join(tmpdir(), `d24-restore-${Date.now()}.list`); writeFileSync(listFile, kept.join('\n'));
  const r = spawnSync(`${pgBin}\\pg_restore.exe`, ['--exit-on-error', '--no-owner', '-L', listFile, ...base, '-d', c.database, dump], { env, encoding: 'utf8' });
  unlinkSync(listFile);
  if (r.status !== 0) { ev.error = String(r.stderr || '').trim().split('\n').slice(0, 6).join(' | ').slice(0, 800); return report(1); }
  const hasTrigger = (await c.query(`SELECT to_regprocedure('public.phoenix_handle_new_user()') IS NOT NULL AS ok`)).rows[0].ok;
  if (hasTrigger) await c.query(`CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.phoenix_handle_new_user()`);
  ev.stage = 'fingerprint';
  const got = JSON.parse((await c.query(fingerprintSql)).rows[0].fingerprint);
  ev.fingerprint_mismatches = Object.keys(expected).filter((k) => JSON.stringify(expected[k]) !== JSON.stringify(got[k]));
  ev.tables = got.tables; ev.total_rows = Object.values(got.row_counts ?? {}).reduce((a, b) => a + Number(b), 0);
  ev.stage = 'outbound probe';
  ev.outbound_findings = (await c.query(OUTBOUND_PROBE_SQL)).rows.map((x) => `${x.kind}:${x.detail}`);
  ev.stage = 'storage';
  ev.storage = await verifyStorageRestore({ manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), dir: storageDir });
  ev.storage = { ok: ev.storage.ok, checked: ev.storage.checked, invalidManifest: ev.storage.invalidManifest.length, missing: ev.storage.missing.length, mismatched: ev.storage.mismatched.length, extra: ev.storage.extra.length };
  ev.restorable = ev.fingerprint_mismatches.length === 0 && ev.outbound_findings.length === 0 && ev.storage.ok === true;
  ev.stage = ev.restorable ? 'PASS' : 'HOLD';
  return report(ev.restorable ? 0 : 1);
} catch (e) {
  ev.error = ev.error ?? String(e?.message ?? e).slice(0, 400); return report(1);
} finally {
  try { await c.query('DROP OWNED BY supabase_admin'); await c.query('DROP ROLE IF EXISTS supabase_admin'); } catch { /* reported by a stale role on the next run */ }
  await c.end().catch(() => undefined);
}
}
process.exit(await run());
