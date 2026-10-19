/**
 * CANDIDATE API BUILD CLOSURE - why Vercel's function compiler reported 11 TS2339 errors that `tsc -b` did not, and a guard that keeps them gone.
 *
 * Cause (proved below): the project build type-checks `api/` with `tsconfig.api.json` (`strict: true`). Vercel's @vercel/node compiles each function
 * WITHOUT that file (the root tsconfig.json is a solution file with no strictness), i.e. with `strictNullChecks` off. Without strictNullChecks the
 * truthiness test `if (!decision.ok)` does NOT narrow `{ ok: true } | { ok: false; status; code }`, so `.status` / `.code` / `.detail` are "missing".
 * The fix is the narrowest form that narrows in BOTH modes and stays fail-closed: `if (decision.ok !== true) deny(...)`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { reassertImportAuthority, type AuthorityDeps } from '../import-authority';
import { verifyPermanentObject } from '../object-integrity';

const ROOT = join(__dirname, '..', '..', '..');
const API = join(ROOT, 'api');

function compileApi(strict: boolean): string[] {
  const cfg = ts.readConfigFile(join(ROOT, 'tsconfig.api.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, strict, noEmit: true, ...(strict ? {} : { strictNullChecks: false }) };
  const program = ts.createProgram(parsed.fileNames, options);
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file && d.file.fileName.replace(/\\/g, '/').includes('/api/'))
    .map((d) => `${d.file!.fileName.split('/api/')[1]}:${d.file!.getLineAndCharacterOfPosition(d.start!).line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

function diagnosticsOf(source: string, strict: boolean): number {
  const name = '/virtual/check.ts';
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, noEmit: true, strict, ...(strict ? {} : { strictNullChecks: false }), skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (f, l, ...r) => (f === name ? ts.createSourceFile(f, source, l) : orig(f, l, ...r));
  host.fileExists = (f) => f === name || ts.sys.fileExists(f);
  host.readFile = (f) => (f === name ? source : ts.sys.readFile(f));
  return ts.getPreEmitDiagnostics(ts.createProgram([name], options, host)).filter((d) => d.file?.fileName === name).length;
}

const UNION = `type D = { ok: true } | { ok: false; status: 403 | 404 | 409; code: string; detail?: string };
declare const decide: () => D; declare function deny(s: number, c: string, d?: string): never;`;

describe('why the two compilers disagree (proved on a minimal reproduction)', () => {
  it('the OLD pattern `!d.ok` narrows under strict but NOT without strictNullChecks (the Vercel compile)', () => {
    const old = `${UNION}\nconst d = decide(); if (!d.ok) deny(d.status, d.code, d.detail);`;
    expect(diagnosticsOf(old, true)).toBe(0);
    expect(diagnosticsOf(old, false)).toBeGreaterThan(0);
  });
  it('the fixed pattern `d.ok !== true` narrows in BOTH modes', () => {
    const fixed = `${UNION}\nconst d = decide(); if (d.ok !== true) deny(d.status, d.code, d.detail);`;
    expect(diagnosticsOf(fixed, true)).toBe(0);
    expect(diagnosticsOf(fixed, false)).toBe(0);
  });
});

describe('the real api/ type-checks cleanly independently of `tsc -b`, in the project mode AND the Vercel-like mode', () => {
  it('strict (tsconfig.api.json as built by the project): no diagnostics', () => { expect(compileApi(true)).toEqual([]); });
  it('non-strict (what @vercel/node uses without tsconfig compilerOptions): no diagnostics - the 11 TS2339 errors are gone', () => { expect(compileApi(false)).toEqual([]); });
});

describe('call sites stay fail-closed and keep their error mapping (static)', () => {
  const finalize = readFileSync(join(API, '_cn2b-core', 'finalize-import.ts'), 'utf8');
  const download = readFileSync(join(API, '_cn2b-core', 'source-download.ts'), 'utf8');
  it('every authority / integrity decision is denied unless it is STRICTLY ok === true, and still returns status, code (and detail)', () => {
    for (const v of ['beforePermanent', 'beforeReplay', 'beforeRegister']) {
      expect(finalize).toContain(`if (${v}.ok !== true) return errorResponse(${v}.status, ${v}.code, ${v}.detail);`);
      expect(finalize).not.toMatch(new RegExp(`if \\(!${v}\\.ok\\)`));
    }
    expect(download).toContain('if (integrity.ok !== true) return errorResponse(integrity.status, integrity.code);');
    expect(download).not.toMatch(/if \(!integrity\.ok\)/);
  });
  it('no `any`, ts-ignore or double cast was introduced in the two handlers for these decisions', () => {
    for (const src of [finalize, download]) {
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|@ts-nocheck/);
      expect(src).not.toMatch(/\bas any\b|:\s*any\b/);
    }
  });
});

describe('negative controls: every denial keeps ok:false with its exact status and code (so the `!== true` gate always fires)', () => {
  const caller = { userId: 'u', accessToken: 't' } as never;
  const rev = (o: Partial<{ organizationId: string; status: string }> = {}) => ({ id: 'r', organizationId: 'org-1', status: 'draft', ...o }) as never;
  const deps = (o: Partial<AuthorityDeps> = {}): AuthorityDeps => ({ resolveRevision: async () => rev(), isAuthorized: async () => true, ...o });
  it('authority denials', async () => {
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps())).toEqual({ ok: true });
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps({ resolveRevision: async () => null }))).toEqual({ ok: false, status: 404, code: 'plan_revision_not_found' });
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps({ resolveRevision: async () => { throw new Error('x'); } }))).toEqual({ ok: false, status: 404, code: 'authority_check_unavailable' });
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps({ resolveRevision: async () => rev({ organizationId: 'org-2' }) }))).toEqual({ ok: false, status: 409, code: 'import_scope_changed' });
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps({ isAuthorized: async () => false }))).toEqual({ ok: false, status: 403, code: 'authority_lost_during_import' });
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps({ isAuthorized: async () => { throw new Error('x'); } }))).toEqual({ ok: false, status: 403, code: 'authority_lost_during_import' });
    expect(await reassertImportAuthority(caller, 'r', 'org-1', deps({ resolveRevision: async () => rev({ status: 'approved' }) }))).toEqual({ ok: false, status: 409, code: 'plan_revision_not_editable', detail: 'approved' });
  });
  it('object-integrity denials', async () => {
    const sha = async (b: Uint8Array) => (b.length === 3 ? 'a'.repeat(64) : 'b'.repeat(64));
    const store = (r: unknown) => ({ download: async () => r as never });
    const bytes = new Uint8Array([1, 2, 3]);
    const ok = { data: { arrayBuffer: async () => bytes.buffer }, error: null };
    expect(await verifyPermanentObject(store(ok), 'k', 'a'.repeat(64), 1024, sha)).toEqual({ ok: true });
    const missing = await verifyPermanentObject(store({ data: null, error: { message: 'nf' } }), 'k', 'a'.repeat(64), 1024, sha);
    expect(missing).toMatchObject({ ok: false }); expect([404, 502]).toContain((missing as { status: number }).status);
    expect(await verifyPermanentObject(store(ok), 'k', 'c'.repeat(64), 1024, sha)).toMatchObject({ ok: false, status: 409 });
    expect(await verifyPermanentObject(store(ok), 'k', 'a'.repeat(64), 2, sha)).toMatchObject({ ok: false, status: 413 });
    expect(await verifyPermanentObject(store(ok), 'k', 'NOT-A-HASH', 1024, sha)).toMatchObject({ ok: false, status: 409 });
    expect(await verifyPermanentObject({ download: async () => { throw new Error('boom'); } }, 'k', 'a'.repeat(64), 1024, sha)).toMatchObject({ ok: false });
  });
  it('a malformed (non-boolean) decision is denied by the strict gate, unlike the old truthiness test', () => {
    const gate = (d: { ok: unknown }) => d.ok !== true;
    for (const bad of [{ ok: undefined }, { ok: 'true' }, { ok: 1 }, { ok: null }, { ok: false }]) expect(gate(bad)).toBe(true);
    expect(gate({ ok: true })).toBe(false);
    expect(!({ ok: 1 } as { ok: unknown }).ok).toBe(false);   // the old `!d.ok` would have ALLOWED the truthy non-boolean
  });
});
