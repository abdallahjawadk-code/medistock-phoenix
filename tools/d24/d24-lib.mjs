/**
 * D24 - recovery proof helpers (PostgreSQL + Storage), LOCAL ONLY. Nothing here connects to a hosted project.
 *
 * 1. assertRestoreIsolation: the restored copy (database AND storage) must be unable to reach Production (or any hosted project):
 *    loopback database only, no hosted URL, no service-role key, no Production ref anywhere in the process environment.
 * 2. OUTBOUND_PROBE_SQL: read-only probe run ON THE RESTORED COPY for anything that could call out (HTTP extensions, schedulers, outbox consumers, vault).
 * 3. verifyStorageRestore: every permanent object of the manifest (exported from the database) exists in the restored folder and re-hashes to its
 *    content address; nothing extra is accepted silently.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const PRODUCTION_REF = 'eyrzxgfkvqybjdgyphap';
export const STAGING_REF = 'knndhlczdlparjfmlxis';
const SHA256_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^permanent\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** SQL (run by the operator on the SOURCE, read-only) that exports the Storage manifest: one row per distinct permanent object. */
export const STORAGE_MANIFEST_SQL = `SELECT DISTINCT split_part(storage_locator, '#', 1) AS key, container_sha256 AS sha256
  FROM public.central_needs_import_batches WHERE storage_locator LIKE 'permanent/%' ORDER BY 1`;

/**
 * Read-only inventory of EVERY Storage object in EVERY bucket (run by the operator on the SOURCE). The backup list is built from THIS, never from the import-batch
 * references alone: an object that no batch row points at (e.g. an orphan or a manually added file) is still part of the Storage state that must be preserved and proven.
 * `referenced` only classifies; it never decides what is copied.
 */
export const STORAGE_INVENTORY_SQL = `SELECT o.bucket_id AS bucket, o.name AS key, (o.metadata->>'size')::bigint AS bytes, o.created_at,
  (o.bucket_id = 'central-needs-source-files' AND EXISTS (SELECT 1 FROM public.central_needs_import_batches b WHERE split_part(b.storage_locator, '#', 1) = o.name)) AS referenced
  FROM storage.objects o ORDER BY 1, 2`;

const isContentAddressed = (r) => r?.bucket === 'central-needs-source-files' && KEY_RE.test(String(r?.key ?? ''));

/**
 * Turns the inventory into the copy plan. EVERY inventory row is copied. Content-addressed permanent objects are later verified against the hash in their own
 * key; every other object (unreferenced, other buckets, staging/) is "observed": its SHA-256 is computed from the SOURCE bytes at copy time and recorded in the
 * manifest, and the restore must reproduce it. Unreferenced objects are listed for the Owner's attention, never dropped and never deleted.
 */
export function planStorageBackup(inventory) {
  const rows = (inventory ?? []).map((r) => ({ bucket: String(r.bucket), key: String(r.key), bytes: Number(r.bytes ?? 0), referenced: r.referenced === true }));
  return {
    total: rows.length,
    copyList: rows.map((r) => `${r.bucket}/${r.key}`),
    contentAddressed: rows.filter(isContentAddressed).length,
    observed: rows.filter((r) => !isContentAddressed(r)).map((r) => `${r.bucket}/${r.key}`),
    unreferenced: rows.filter((r) => !r.referenced).map((r) => `${r.bucket}/${r.key}`),
  };
}

/** The list of objects actually copied must equal the inventory: nothing missing, nothing invented. */
export function assertBackupCoversInventory(inventory, copied) {
  const want = new Set(planStorageBackup(inventory).copyList); const got = new Set(copied ?? []);
  const missing = [...want].filter((k) => !got.has(k)).sort(); const unexpected = [...got].filter((k) => !want.has(k)).sort();
  return { ok: missing.length === 0 && unexpected.length === 0 && want.size > 0, missing, unexpected };
}

/** Read-only probe for the RESTORED database: anything that could make it talk to the outside world. Every returned row is a finding. */
export const OUTBOUND_PROBE_SQL = `
SELECT 'extension' AS kind, extname AS detail FROM pg_extension WHERE extname IN ('pg_net', 'pg_cron', 'http', 'dblink', 'postgres_fdw', 'supabase_vault')
UNION ALL SELECT 'foreign_server', srvname FROM pg_foreign_server
UNION ALL SELECT 'function_http_call', p.oid::regprocedure::text FROM pg_proc p WHERE p.prosrc ~* '(net\\.http_(get|post|delete)|http_post\\(|http_get\\(|dblink\\()' AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
UNION ALL SELECT 'subscription', subname FROM pg_subscription
UNION ALL SELECT 'event_trigger', evtname FROM pg_event_trigger`;

/** @returns {string[]} violations (empty = isolated) */
export function assertRestoreIsolation({ env = {}, databaseUrl = '', storageDir = '' } = {}) {
  const v = [];
  let host = '';
  try { host = new URL(databaseUrl.replace(/^postgres(ql)?:/, 'http:')).hostname; } catch { host = ''; }
  if (!databaseUrl) v.push('no restore database URL given');
  else if (!LOOPBACK.has(host)) v.push(`restore database host "${host}" is not loopback`);
  if (/supabase\.(co|com)|pooler\.supabase/i.test(databaseUrl)) v.push('restore database URL names a hosted Supabase endpoint');
  if (databaseUrl.includes(PRODUCTION_REF)) v.push('restore database URL names the Production project');
  if (!storageDir || /^[a-z][a-z0-9+.-]*:\/\//i.test(storageDir)) v.push('storage restore target must be a local folder');
  for (const [k, val] of Object.entries(env)) {
    const s = String(val ?? '');
    if (s.includes(PRODUCTION_REF)) v.push(`environment variable ${k} names the Production project`);
    if (/service_role|SERVICE_ROLE/.test(k) && s) v.push(`environment variable ${k} holds a service-role credential`);
    if (/^(PHOENIX_)?(PRODUCTION|PROD)_/.test(k) && s) v.push(`environment variable ${k} is a Production setting`);
    if (/^(SUPABASE_URL|VITE_PHOENIX_SUPABASE_URL|PHOENIX_STAGING_DB_URL|PHOENIX_PRODUCTION_DATABASE_URL)$/.test(k) && s) v.push(`environment variable ${k} points at a hosted project`);
  }
  return v;
}

export async function sha256File(path) {
  const h = createHash('sha256');
  await new Promise((res, rej) => { createReadStream(path).on('data', (d) => h.update(d)).on('error', rej).on('end', res); });
  return h.digest('hex');
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

/**
 * @param {{ manifest: Array<{key: string, sha256: string}>, dir: string }} a
 * @returns {Promise<{ ok: boolean, checked: number, invalidManifest: string[], missing: string[], mismatched: string[], extra: string[] }>}
 */
export async function verifyStorageRestore({ manifest, dir }) {
  const root = resolve(dir);
  const out = { ok: false, checked: 0, invalidManifest: [], missing: [], mismatched: [], extra: [] };
  const wanted = new Set();
  for (const row of manifest) {
    let key = String(row?.key ?? ''); const sha = String(row?.sha256 ?? '');
    if (row?.kind === 'observed') {
      // an object that is not content-addressed (unreferenced, another bucket, staging/): its hash was observed on the SOURCE bytes at copy time; stored as <bucket>/<key>
      const bucket = String(row?.bucket ?? '');
      const segs = `${bucket}/${key}`.split('/');
      if (!bucket || !key || !SHA256_RE.test(sha) || segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) { out.invalidManifest.push(`${bucket}/${key}`); continue; }
      key = `${bucket}/${key}`;
    } else if (row?.kind === 'content_addressed') {
      // a permanent evidence object copied with its bucket: stored as <bucket>/<key>; the hash in its own key must equal the recorded one
      const bucket = String(row?.bucket ?? '');
      if (!bucket || bucket.includes('/') || bucket === '.' || bucket === '..' || !KEY_RE.test(key) || !SHA256_RE.test(sha) || key.split('/')[3] !== sha) { out.invalidManifest.push(`${bucket}/${key}`); continue; }
      key = `${bucket}/${key}`;
    } else if (!KEY_RE.test(key) || !SHA256_RE.test(sha) || key.split('/')[3] !== sha) {
      // content-addressed: the last segment of the key IS the hash; a manifest that disagrees with its own key is itself evidence of damage
      out.invalidManifest.push(key || '(empty)'); continue;
    }
    wanted.add(key);
    const target = resolve(root, ...key.split('/'));
    if (target !== root && !target.startsWith(root + sep)) { out.invalidManifest.push(key); continue; }
    if (!existsSync(target) || !statSync(target).isFile()) { out.missing.push(key); continue; }
    out.checked += 1;
    if ((await sha256File(target)) !== sha) out.mismatched.push(key);
  }
  if (existsSync(root)) out.extra = walk(root).filter((f) => !wanted.has(f)).sort();
  out.ok = out.invalidManifest.length === 0 && out.missing.length === 0 && out.mismatched.length === 0 && out.extra.length === 0 && out.checked === wanted.size && manifest.length > 0;
  return out;
}
