import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(() => { throw new Error('General directory must not be used'); }) }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc, from } }));
import { listAnnualBeneficiaries } from '../annual-beneficiaries.service';
const owner = 'c5100000-0000-4000-8000-000000000001';
const id = (n: number) => `c5200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row = (n: number) => ({ id: id(n), name: `Hospital ${n}`, nameAr: `مستشفى ${n}` });
const page = (rows: unknown[], nextAfterId: string | null = null) => ({ data: { version: 1, ownerOrgId: owner, rows, nextAfterId }, error: null });
beforeEach(() => { rpc.mockReset(); from.mockClear(); });
describe('annual beneficiary names use only the governed caller-scoped reader', () => {
  it('reads all keyset pages with the same owner and no directory table query', async () => {
    const first = Array.from({ length: 50 }, (_, n) => row(n+1));
    rpc.mockResolvedValueOnce(page(first,id(50))).mockResolvedValueOnce(page([row(51)]));
    expect(await listAnnualBeneficiaries(owner)).toEqual([...first,row(51)]);
    expect(rpc.mock.calls).toEqual([
      ['phoenix_manual_beneficiaries_v1',{ p_organization_id: owner,p_after_id: null,p_limit: 50 }],
      ['phoenix_manual_beneficiaries_v1',{ p_organization_id: owner,p_after_id: id(50),p_limit: 50 }],
    ]); expect(from).not.toHaveBeenCalled();
  });
  it('accepts a genuinely empty current response', async () => {
    rpc.mockResolvedValue(page([])); expect(await listAnnualBeneficiaries(owner)).toEqual([]);
  });
  it('rejects cross-owner metadata and unexpected private organization columns', async () => {
    rpc.mockResolvedValueOnce({ data: { ...page([]).data,ownerOrgId: id(1) },error: null });
    await expect(listAnnualBeneficiaries(owner)).rejects.toThrow();
    rpc.mockResolvedValueOnce(page([{ ...row(1),contact_email: 'private@invalid.local' }]));
    await expect(listAnnualBeneficiaries(owner)).rejects.toThrow();
  });
  it('rejects duplicate or backward IDs and dishonest cursors', async () => {
    for (const response of [page([row(1),row(1)]),page([row(2),row(1)]),page([row(1)],id(1))]) {
      rpc.mockResolvedValueOnce(response); await expect(listAnnualBeneficiaries(owner)).rejects.toThrow();
    }
  });
  it('never returns partial rows or falls back after a failed later page', async () => {
    rpc.mockResolvedValueOnce(page(Array.from({ length: 50 },(_,n)=>row(n+1)),id(50)))
      .mockResolvedValueOnce({ data: null,error: { code: '42501',message: 'forbidden_central_needs' } });
    await expect(listAnnualBeneficiaries(owner)).rejects.toThrow(); expect(from).not.toHaveBeenCalled(); expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('surfaces a missing candidate without a legacy or directory retry', async () => {
    rpc.mockResolvedValue({ data: null,error: { code: 'PGRST202',message: 'Reader missing' } });
    await expect(listAnnualBeneficiaries(owner)).rejects.toThrow(); expect(rpc).toHaveBeenCalledTimes(1); expect(from).not.toHaveBeenCalled();
  });
});
