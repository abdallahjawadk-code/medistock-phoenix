// D24 Storage copy - DOWNLOAD ONLY. Copies EVERY object of the inventory (all buckets, referenced or not) from the PRODUCTION project into a local folder and writes the manifest the restore verifier uses.
// It never uploads, updates, moves, removes or signs anything; the only Storage method used is `download`. The service credential comes only from the environment of the operator window (hidden prompt) and is never printed.
//   node tools/d24/storage-copy.mjs --inventory <inventory.json> --out <folder> --manifest <manifest.json> [--max-bytes <n>]
// env: D24_SUPABASE_URL (must be exactly https://<production ref>.supabase.co), D24_SERVICE_KEY
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { PRODUCTION_REF, assertBackupCoversInventory, planStorageBackup } from './d24-lib.mjs';

const KEY_RE = /^permanent\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/([0-9a-f]{64})$/;
export const PRODUCTION_URL = `https://${PRODUCTION_REF}.supabase.co`;

/**
 * @param {{ inventory: Array<{bucket: string, key: string, bytes?: number, referenced?: boolean}>, client: any, outDir: string, maxBytes?: number }} a
 * `client` needs only `.storage.from(bucket).download(key)`.
 */
export async function copyStorage({ inventory, client, outDir, maxBytes = 2 * 1024 * 1024 * 1024 }) {
  const plan = planStorageBackup(inventory);
  const root = resolve(outDir);
  const manifest = []; const problems = []; let total = 0;
  for (const r of inventory) {
    const bucket = String(r.bucket); const key = String(r.key); const rel = `${bucket}/${key}`;
    const segs = rel.split('/');
    if (!bucket || segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) { problems.push({ object: rel, error: 'unsafe object name' }); continue; }
    const target = resolve(root, ...segs);
    if (!target.startsWith(root + sep)) { problems.push({ object: rel, error: 'path escape' }); continue; }
    const { data, error } = await client.storage.from(bucket).download(key);
    if (error || !data) { problems.push({ object: rel, error: 'download failed' }); continue; }
    const bytes = Buffer.from(await data.arrayBuffer());
    total += bytes.length;
    if (total > maxBytes) { problems.push({ object: rel, error: 'total size cap exceeded' }); break; }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const addr = bucket === 'central-needs-source-files' ? KEY_RE.exec(key) : null;
    if (addr && addr[1] !== sha256) { problems.push({ object: rel, error: 'content-addressed object does not hash to its key (SOURCE damage; nothing was altered)' }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });                         // never overwrite a local file
    manifest.push(addr ? { kind: 'content_addressed', bucket, key, sha256, bytes: bytes.length } : { kind: 'observed', bucket, key, sha256, bytes: bytes.length });
  }
  const coverage = assertBackupCoversInventory(inventory, manifest.map((m) => `${m.bucket}/${m.key}`));
  const unreferenced = plan.unreferenced;
  return { ok: problems.length === 0 && coverage.ok, manifest, problems, coverage, total: plan.total, copied: manifest.length, bytes: total, unreferenced };
}

async function main() {
  const arg = process.argv.slice(2); const val = (f) => { const i = arg.indexOf(f); return i >= 0 ? arg[i + 1] : undefined; };
  const [invPath, out, manifestPath] = [val('--inventory'), val('--out'), val('--manifest')];
  if (!invPath || !out || !manifestPath) { console.error('usage: --inventory <json> --out <folder> --manifest <json>'); return 2; }
  if (process.env.D24_SUPABASE_URL !== PRODUCTION_URL) { console.error(`STOP-IDENTITY: D24_SUPABASE_URL must be exactly ${PRODUCTION_URL}`); return 3; }
  if (!process.env.D24_SERVICE_KEY) { console.error('STOP-INPUT: D24_SERVICE_KEY is not set'); return 3; }
  if (existsSync(out) && statSync(out).isDirectory() && (await import('node:fs')).readdirSync(out).length > 0) { console.error('STOP-TARGET: the output folder must be empty'); return 3; }
  const inventory = JSON.parse(readFileSync(invPath, 'utf8'));
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(PRODUCTION_URL, process.env.D24_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const res = await copyStorage({ inventory, client, outDir: out, maxBytes: Number(val('--max-bytes') ?? 2 * 1024 * 1024 * 1024) });
  writeFileSync(manifestPath, JSON.stringify(res.manifest, null, 1), { flag: 'wx' });
  console.log(JSON.stringify({ ok: res.ok, inventory: res.total, copied: res.copied, bytes: res.bytes, unreferenced: res.unreferenced.length, problems: res.problems.length, missing: res.coverage.missing.length }));
  for (const p of res.problems.slice(0, 5)) console.error('problem:', p.error);
  return res.ok ? 0 : 1;
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) process.exit(await main());
