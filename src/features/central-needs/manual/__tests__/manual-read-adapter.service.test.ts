import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));
import { listNeedsDossiers, readAnnualNeeds } from '../dossier.service';
import { realJourneyApi } from '../manual-journey.service';
beforeEach(() => rpc.mockReset().mockResolvedValue({ data: [], error: null }));
describe('annual-mode transaction adapters preserve legacy callers and refuse without fallback', () => {
  it('uses the two caller-preserving annual read adapters only when requested', async () => {
    await listNeedsDossiers('owner', 2026, true); await readAnnualNeeds('owner', 2026, true);
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['phoenix_manual_read_dossiers_v1', 'phoenix_manual_read_annual_summary_v1']);
    expect(rpc.mock.calls.every(row => row[1].p_organization_id === 'owner' && row[1].p_plan_year === 2026)).toBe(true);
  });
  it('retains original RPCs for callers without the annual opt-in', async () => {
    await listNeedsDossiers('owner', 2026); await readAnnualNeeds('owner', 2026);
    await realJourneyApi.listDossierRevisions!('plan');
    expect(rpc.mock.calls.map(row => row[0])).toEqual(['phoenix_central_needs_list_dossiers', 'phoenix_central_needs_annual_summary', 'phoenix_central_needs_dossier_revisions']);
  });
  it('uses the invoker revision adapter after the annual plan exists', async () => {
    expect(await realJourneyApi.listDossierRevisions!('plan', true)).toEqual([]);
    expect(rpc).toHaveBeenCalledWith('phoenix_manual_read_dossier_revisions_v1', { p_plan_id: 'plan' });
  });
  it('surfaces a missing or refused adapter without calling the legacy reader', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Missing annual read adapter' } });
    await expect(listNeedsDossiers('owner', 2026, true)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1); expect(rpc.mock.calls[0][0]).toBe('phoenix_manual_read_dossiers_v1');
  });
});
