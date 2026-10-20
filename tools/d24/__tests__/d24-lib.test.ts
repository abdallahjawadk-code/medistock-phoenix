import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUTBOUND_PROBE_SQL, PRODUCTION_REF, STORAGE_INVENTORY_SQL, STORAGE_MANIFEST_SQL, assertBackupCoversInventory, assertRestoreIsolation, planStorageBackup, verifyStorageRestore } from '../d24-lib.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', REV = '22222222-2222-4222-8222-222222222222';
const sha = (b: string) => createHash('sha256').update(b).digest('hex');
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'd24-'));
  for (const [rel, body] of Object.entries(files)) { const p = join(dir, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); }
  return dir;
}
const entry = (body: string) => ({ key: `permanent/${ORG}/${REV}/${sha(body)}`, sha256: sha(body) });

describe('assertRestoreIsolation', () => {
  const ok = { env: { PATH: 'x', TEMP: 'y' }, databaseUrl: 'postgresql://postgres:pw@127.0.0.1:55433/restore', storageDir: 'D:/restore/storage' };
  it('accepts a loopback database, a local folder and a clean environment', () => { expect(assertRestoreIsolation(ok)).toEqual([]); });
  it.each([
    ['a hosted pooler URL', { databaseUrl: 'postgresql://postgres.abc:pw@aws-0-eu.pooler.supabase.com:5432/postgres' }],
    ['the Production project', { databaseUrl: `postgresql://postgres:pw@db.${PRODUCTION_REF}.supabase.co:5432/postgres` }],
    ['a non-loopback host', { databaseUrl: 'postgresql://postgres:pw@10.0.0.5:5432/restore' }],
    ['no database URL', { databaseUrl: '' }],
    ['a remote storage target', { storageDir: 's3://bucket/restore' }],
    ['a Production ref in the environment', { env: { SOMETHING: `https://${PRODUCTION_REF}.supabase.co` } }],
    ['a service-role credential in the environment', { env: { SUPABASE_SERVICE_ROLE_KEY: 'x' } }],
    ['a hosted URL variable', { env: { VITE_PHOENIX_SUPABASE_URL: 'https://x.supabase.co' } }],
  ])('refuses %s', (_l, patch) => { expect(assertRestoreIsolation({ ...ok, ...(patch as object) }).length).toBeGreaterThan(0); });
});

describe('verifyStorageRestore', () => {
  it('passes when every manifest object exists and re-hashes to its content address', async () => {
    const a = entry('workbook-a'), b = entry('workbook-b');
    const dir = fixture({ [a.key]: 'workbook-a', [b.key]: 'workbook-b' });
    expect(await verifyStorageRestore({ manifest: [a, b], dir })).toMatchObject({ ok: true, checked: 2, missing: [], mismatched: [], extra: [] });
  });
  it('fails on a missing object, a corrupted object, an unexpected extra object and an empty manifest', async () => {
    const a = entry('a'), b = entry('b');
    const dir = fixture({ [a.key]: 'CORRUPTED', [`permanent/${ORG}/${REV}/${'f'.repeat(64)}`]: 'stray' });
    const r = await verifyStorageRestore({ manifest: [a, b], dir });
    expect(r.ok).toBe(false); expect(r.mismatched).toEqual([a.key]); expect(r.missing).toEqual([b.key]); expect(r.extra).toHaveLength(1);
    expect((await verifyStorageRestore({ manifest: [], dir })).ok).toBe(false);
  });
  it('rejects a manifest whose key disagrees with its own hash, or a key that is not a permanent content address (no path traversal)', async () => {
    const dir = fixture({});
    const bad = [{ key: `permanent/${ORG}/${REV}/${sha('x')}`, sha256: sha('y') }, { key: '../../etc/passwd', sha256: sha('z') }, { key: `permanent/${ORG}/${REV}/../${sha('q')}`, sha256: sha('q') }];
    const r = await verifyStorageRestore({ manifest: bad, dir });
    expect(r.ok).toBe(false); expect(r.invalidManifest).toHaveLength(3); expect(r.checked).toBe(0);
  });
});

describe('exported SQL', () => {
  it('the manifest export is a single read-only SELECT and the outbound probe contains no write', () => {
    for (const q of [STORAGE_MANIFEST_SQL, OUTBOUND_PROBE_SQL]) {
      expect(q).toMatch(/^\s*SELECT/i);
      // statements only: string literals may legitimately name function patterns such as net.http_delete
      expect(q.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i);
    }
  });
});

describe('backup list covers ALL Storage objects, not only those referenced by import batches', () => {
  const addr = entry('referenced-workbook');
  const inventory = [
    { bucket: 'central-needs-source-files', key: addr.key, bytes: 20, referenced: true },
    { bucket: 'central-needs-source-files', key: `permanent/${ORG}/${REV}/${sha('third-file')}`, bytes: 10, referenced: false },     // permanent object no batch row points at
    { bucket: 'central-needs-source-files', key: 'staging/odd name.xlsx', bytes: 5, referenced: false },
    { bucket: 'other-bucket', key: 'logo.png', bytes: 7, referenced: false },
  ];
  it('the plan copies every inventory object (referenced or not, any bucket) and lists the unreferenced ones for the Owner', () => {
    const plan = planStorageBackup(inventory);
    expect(plan.total).toBe(4); expect(plan.copyList).toHaveLength(4);
    expect(plan.contentAddressed).toBe(2); expect(plan.observed).toEqual(['central-needs-source-files/staging/odd name.xlsx', 'other-bucket/logo.png']);
    expect(plan.unreferenced).toHaveLength(3);
  });
  it('a copy list built from the import-batch references alone is detected as incomplete', () => {
    const fromBatchesOnly = [`central-needs-source-files/${addr.key}`];
    const r = assertBackupCoversInventory(inventory, fromBatchesOnly);
    expect(r.ok).toBe(false); expect(r.missing).toHaveLength(3);
    expect(assertBackupCoversInventory(inventory, planStorageBackup(inventory).copyList).ok).toBe(true);
    expect(assertBackupCoversInventory([], []).ok).toBe(false);                           // an empty inventory is never a pass
  });
  it('the restore verifier proves observed objects against the hash recorded at copy time, and flags a corrupted one', async () => {
    const dir = fixture({ 'other-bucket/logo.png': 'PNGBYTES', 'central-needs-source-files/staging/odd name.xlsx': 'xl' });
    const ok = [{ kind: 'observed', bucket: 'other-bucket', key: 'logo.png', sha256: sha('PNGBYTES') }, { kind: 'observed', bucket: 'central-needs-source-files', key: 'staging/odd name.xlsx', sha256: sha('xl') }];
    expect(await verifyStorageRestore({ manifest: ok, dir })).toMatchObject({ ok: true, checked: 2 });
    const bad = [{ ...ok[0], sha256: sha('different') }, ok[1]];
    expect((await verifyStorageRestore({ manifest: bad, dir })).mismatched).toEqual(['other-bucket/logo.png']);
  });
  it('an observed row cannot escape the restore folder', async () => {
    const dir = fixture({});
    const r = await verifyStorageRestore({ manifest: [{ kind: 'observed', bucket: 'b', key: '../../x', sha256: sha('x') }, { kind: 'observed', bucket: '', key: 'k', sha256: sha('k') }], dir });
    expect(r.invalidManifest).toHaveLength(2); expect(r.ok).toBe(false);
  });
  it('the inventory SQL is read-only and spans every bucket', () => {
    expect(STORAGE_INVENTORY_SQL).toMatch(/^\s*SELECT/i);
    expect(STORAGE_INVENTORY_SQL.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i);
    expect(STORAGE_INVENTORY_SQL).not.toMatch(/WHERE\s+o\.bucket_id/i);
  });
});

describe('D24 status wording (a tool test is not a restore proof)', () => {
  const doc = readFileSync(join(__dirname, '..', 'D24-PROCEDURE.md'), 'utf8').split(String.fromCharCode(13)).join('');
  it('says PROCEDURE ONLY / not operational restore evidence, and treats a zero-object source as HOLD', () => {
    expect(doc).toMatch(/PROCEDURE ONLY - NOT OPERATIONAL RESTORE EVIDENCE/);
    expect(doc).toMatch(/do \*\*not\*\* prove that a PostgreSQL \+ Storage backup/);
    expect(doc).toMatch(/zero-object source is HOLD/);
  });
  it('an empty manifest is never a pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd24-empty-'));
    expect((await verifyStorageRestore({ manifest: [], dir })).ok).toBe(false);
  });
});
