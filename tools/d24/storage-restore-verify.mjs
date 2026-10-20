// D24 Storage restore verification (LOCAL, read-only on the restored folder; never contacts a hosted project).
//   node tools/d24/storage-restore-verify.mjs --manifest <manifest.json> --dir <restored-storage-folder> [--db-url <restored loopback db url>]
// manifest.json = the JSON array exported with STORAGE_MANIFEST_SQL from the SOURCE (key + sha256). Exit 0 only when every object re-hashes to its address
// and nothing unexpected is present; also refuses to run when the restore environment is not isolated.
import { readFileSync } from 'node:fs';
import { assertRestoreIsolation, verifyStorageRestore } from './d24-lib.mjs';

const arg = process.argv.slice(2); const val = (f) => { const i = arg.indexOf(f); return i >= 0 ? arg[i + 1] : undefined; };
const [manifestPath, dir, dbUrl] = [val('--manifest'), val('--dir'), val('--db-url') ?? ''];
if (!manifestPath || !dir) { console.error('usage: --manifest <json> --dir <folder> [--db-url <loopback url>]'); process.exit(2); }
const violations = assertRestoreIsolation({ env: process.env, databaseUrl: dbUrl || 'postgresql://127.0.0.1/restore', storageDir: dir });
if (violations.length) { console.error('STOP-ISOLATION:\n- ' + violations.join('\n- ')); process.exit(3); }
const res = await verifyStorageRestore({ manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), dir });
console.log(JSON.stringify({ ok: res.ok, checked: res.checked, invalidManifest: res.invalidManifest.length, missing: res.missing.length, mismatched: res.mismatched.length, extra: res.extra.length }));
for (const k of [...res.missing.slice(0, 5), ...res.mismatched.slice(0, 5)]) console.error('problem:', k);
process.exit(res.ok ? 0 : 1);
