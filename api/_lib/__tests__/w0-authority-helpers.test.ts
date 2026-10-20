/**
 * W0 - the Central Needs Excel API authority helpers (R1 release gate).
 *
 * Pure tests: the helpers only call two public RPCs on the CALLER's client. Everything fails closed: only a literal `true`
 * opens, and an error (including PGRST202 on a pre-R1-a database), a null, a string or an empty row closes.
 * The database semantics of the wrapper itself (cross-organization / organization-less super_admin) are proven on the
 * PostgreSQL rig in supabase/migrations/__tests__/w0-central-needs-excel-path-authority.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { callerExcelImportOpen, callerHasCentralNeedsAuthority } from '../supabase.ts';
import { reassertImportAuthority, type AuthorityDeps } from '../import-authority.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const fake = (answer: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const caller = { userId: 'u', accessToken: 't', client: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: answer.data ?? null, error: answer.error ?? null }; } } };
  return { caller: caller as never, calls };
};

describe('callerHasCentralNeedsAuthority', () => {
  it('asks the R1 wrapper (never the legacy super_admin helper) with the organization and the key', async () => {
    const { caller, calls } = fake({ data: true });
    expect(await callerHasCentralNeedsAuthority(caller, ORG, 'central_needs.import')).toBe(true);
    expect(calls).toEqual([{ fn: 'phoenix_central_needs_actor_authorized', args: { p_organization_id: ORG, p_key: 'central_needs.import' } }]);
  });
  it.each([
    ['false', { data: false }], ['null', { data: null }], ['the string "true"', { data: 'true' }], ['1', { data: 1 }],
    ['a database error', { error: { code: '42501', message: 'x' } }], ['PGRST202 (wrapper missing, pre-R1-a)', { error: { code: 'PGRST202', message: 'not found' } }],
  ])('refuses on %s', async (_label, answer) => {
    expect(await callerHasCentralNeedsAuthority(fake(answer as never).caller, ORG, 'central_needs.view')).toBe(false);
  });
});

describe('callerExcelImportOpen', () => {
  it('reads excel_import_open for the revision, from my_capabilities, as the caller', async () => {
    const { caller, calls } = fake({ data: [{ view: true, excel_import_open: true }] });
    expect(await callerExcelImportOpen(caller, ORG, REV)).toBe(true);
    expect(calls).toEqual([{ fn: 'phoenix_central_needs_my_capabilities', args: { p_organization_id: ORG, p_plan_revision_id: REV } }]);
  });
  it('accepts an object row as well as an array row', async () => {
    expect(await callerExcelImportOpen(fake({ data: { excel_import_open: true } }).caller, ORG, REV)).toBe(true);
  });
  it.each([
    ['false (R1-b activated)', { data: [{ excel_import_open: false }] }], ['missing field', { data: [{ view: true }] }], ['empty array', { data: [] }],
    ['null', { data: null }], ['the string "true"', { data: [{ excel_import_open: 'true' }] }], ['an error', { error: { code: 'XX000', message: 'x' } }],
    ['PGRST202 (pre-R1-a)', { error: { code: 'PGRST202', message: 'nf' } }],
  ])('is CLOSED on %s', async (_label, answer) => {
    expect(await callerExcelImportOpen(fake(answer as never).caller, ORG, REV)).toBe(false);
  });
});

describe('reassertImportAuthority also re-checks that Excel entry is still open', () => {
  const rev = { id: REV, organizationId: ORG, planId: 'p', status: 'draft', revisionNumber: 1 } as never;
  const deps = (o: Partial<AuthorityDeps> = {}): AuthorityDeps => ({ resolveRevision: async () => rev, isAuthorized: async () => true, isExcelImportOpen: async () => true, ...o });
  const caller = {} as never;
  it('open + authorized -> ok', async () => { expect(await reassertImportAuthority(caller, REV, ORG, deps())).toEqual({ ok: true }); });
  it('closed after activation -> 409 excel_import_closed (before the permanent write)', async () => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps({ isExcelImportOpen: async () => false }))).toEqual({ ok: false, status: 409, code: 'excel_import_closed' });
  });
  it('the open check throwing is CLOSED', async () => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps({ isExcelImportOpen: async () => { throw new Error('rpc'); } }))).toEqual({ ok: false, status: 409, code: 'excel_import_closed' });
  });
  it('authority is still judged first: not authorized -> 403 even when entry is closed', async () => {
    expect(await reassertImportAuthority(caller, REV, ORG, deps({ isAuthorized: async () => false, isExcelImportOpen: async () => false }))).toEqual({ ok: false, status: 403, code: 'authority_lost_during_import' });
  });
});

describe('no API source uses the legacy super_admin helper', () => {
  const API = join(__dirname, '..', '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === '__tests__' || n === 'node_modules') return [];
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
  it('phoenix_status_center_authorized and callerIsAuthorized appear nowhere under api/ (outside tests)', () => {
    for (const f of files(API)) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // code only: comments may name the legacy helper to explain why it is banned
      expect(src, f).not.toMatch(/phoenix_status_center_authorized/);
      expect(src, f).not.toMatch(/callerIsAuthorized/);
    }
  });
  it('the three Excel paths each authorize through the R1 wrapper', () => {
    const core = join(API, '_cn2b-core');
    for (const f of ['upload-ticket.ts', 'finalize-import.ts', 'source-download.ts']) {
      expect(readFileSync(join(core, f), 'utf8'), f).toContain('callerHasCentralNeedsAuthority(');
    }
    for (const f of ['upload-ticket.ts', 'finalize-import.ts']) {
      expect(readFileSync(join(core, f), 'utf8'), f).toContain('callerExcelImportOpen(');
    }
  });
});
