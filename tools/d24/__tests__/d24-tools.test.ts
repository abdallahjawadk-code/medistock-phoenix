import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_URL, copyStorage } from '../storage-copy.mjs';
import { verifyStorageRestore } from '../d24-lib.mjs';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const bufs = { a: Buffer.from('workbook-a'), third: Buffer.from('the third permanent file'), logo: Buffer.from('png') };
const inv = [
  { bucket: 'central-needs-source-files', key: `permanent/${A}/${B}/${sha(bufs.a)}`, referenced: true },
  { bucket: 'central-needs-source-files', key: `permanent/${A}/${B}/${sha(bufs.third)}`, referenced: false },
  { bucket: 'assets', key: 'logo.png', referenced: false },
];
const content = (b: string, k: string) => (k === inv[0].key ? bufs.a : k === inv[1].key ? bufs.third : b === 'assets' ? bufs.logo : Buffer.alloc(0));
const client = (override?: (b: string, k: string) => Buffer | null) => ({ storage: { from: (bucket: string) => ({ download: async (key: string) => { const x = override ? override(bucket, key) : content(bucket, key); return x ? { data: new Blob([x]), error: null } : { data: null, error: { message: 'x' } }; } }) } });

describe('storage-copy (download only, full inventory)', () => {
  it('copies EVERY inventory object (including the unreferenced third file and other buckets) and the restore verifier accepts the result', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'd24-copy-'));
    const r = await copyStorage({ inventory: inv, client: client(), outDir });
    expect(r.ok).toBe(true); expect(r.copied).toBe(3); expect(r.unreferenced).toHaveLength(2);
    expect(r.manifest.map((m: any) => m.kind)).toEqual(['content_addressed', 'content_addressed', 'observed']);
    expect(await verifyStorageRestore({ manifest: r.manifest, dir: outDir })).toMatchObject({ ok: true, checked: 3, extra: [] });
  });
  it('a content-addressed object that does not hash to its key is reported as SOURCE damage and the run is not ok', async () => {
    const r = await copyStorage({ inventory: inv, client: client((b, k) => (k === inv[1].key ? Buffer.from('CORRUPT') : content(b, k))), outDir: mkdtempSync(join(tmpdir(), 'd24-copy-')) });
    expect(r.ok).toBe(false); expect(r.problems[0].error).toMatch(/does not hash to its key/); expect(r.coverage.ok).toBe(false);
  });
  it('a failed download, an unsafe name, or an exceeded size cap stops being "ok"', async () => {
    expect((await copyStorage({ inventory: inv, client: client((b, k) => (b === 'assets' ? null : content(b, k))), outDir: mkdtempSync(join(tmpdir(), 'd24-copy-')) })).ok).toBe(false);
    expect((await copyStorage({ inventory: [{ bucket: 'assets', key: '../escape', referenced: false }], client: client(() => Buffer.from('x')), outDir: mkdtempSync(join(tmpdir(), 'd24-copy-')) })).ok).toBe(false);
    expect((await copyStorage({ inventory: inv, client: client(), outDir: mkdtempSync(join(tmpdir(), 'd24-copy-')), maxBytes: 5 })).ok).toBe(false);
  });
  it('an empty inventory is never ok', async () => {
    expect((await copyStorage({ inventory: [], client: client(), outDir: mkdtempSync(join(tmpdir(), 'd24-copy-')) })).ok).toBe(false);
  });
  it('only reads Production Storage: the sole Storage method is download, the URL is pinned, nothing is signed/uploaded/removed', () => {
    const src = read('storage-copy.mjs').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/\.download\(/);
    expect(src).not.toMatch(/storage\.from\([^)]*\)\.(?!download\()\w+\(/);          // every Storage call is .download(
    expect(src).not.toMatch(/storage\.(createBucket|emptyBucket|deleteBucket|updateBucket)\(/);
    expect(src).toContain("process.env.D24_SUPABASE_URL !== PRODUCTION_URL");
    expect(PRODUCTION_URL).toBe('https://eyrzxgfkvqybjdgyphap.supabase.co');
    expect(src).not.toMatch(/console\.(log|error)\([^)]*process\.env\.D24_SERVICE_KEY/);
  });
});

describe('restore-verify and d24-counts static contract', () => {
  const rv = read('restore-verify.mjs').replace(/^\s*\/\/.*$/gm, '');
  it('restores only into the LOCAL cluster, with --exit-on-error, a clean minimal environment and the isolation guard first', () => {
    expect(rv).toContain('assertRestoreIsolation');
    expect(rv.indexOf('assertRestoreIsolation')).toBeLessThan(rv.indexOf('freshRigDb({})'));
    expect(rv).toContain('--exit-on-error');
    expect(rv).toMatch(/const env = \{ PATH:/);
    expect(rv).not.toMatch(/\.supabase\.co/);
  });
  it('the fingerprint SQL is one read-only SELECT that never touches the storage schema', () => {
    const q = read('d24-counts.sql').replace(/^\s*--.*$/gm, '');
    expect(q.trim()).toMatch(/^SELECT/i);
    expect(q.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i);
    expect(q).not.toMatch(/storage\./);
  });
});
