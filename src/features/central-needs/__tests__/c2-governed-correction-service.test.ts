/**
 * C2 — the client service boundary of the governed correction lifecycle (M215).
 *
 *   * openCorrectionRevision calls the dedicated RPC with the exact parameter
 *     names, including the stale fence (p_expected_latest_revision_id) and the
 *     reason, and surfaces the server's stable code verbatim — no retry.
 *   * openPlanRevision is the NEW/current annual draft only: it always sends
 *     p_open_next_revision = false.
 *   * fetchRevisionLifecycle maps the narrow history read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const service = await import('../central-needs.service');

beforeEach(() => rpc.mockReset());

describe('C2 — openCorrectionRevision', () => {
  it('calls the governed RPC with the fence and the reason, and maps the answer', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true, plan_id: 'plan-1', plan_year: 2025, plan_revision_id: 'rev-2', revision_number: 2, status: 'draft',
        opened_after_revision_id: 'rev-1', opened_after_status: 'approved', effective_approved_revision_id: 'rev-1',
        correction_reason: 'recount',
      },
      error: null,
    });
    const r = await service.openCorrectionRevision('org-1', 2025, 'rev-1', 'recount');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('phoenix_central_needs_open_correction_revision', {
      p_organization_id: 'org-1',
      p_plan_year: 2025,
      p_expected_latest_revision_id: 'rev-1',
      p_reason: 'recount',
    });
    expect(r).toEqual({
      planRevisionId: 'rev-2', revisionNumber: 2, planYear: 2025,
      openedAfterRevisionId: 'rev-1', effectiveApprovedRevisionId: 'rev-1',
    });
  });

  it.each([
    'central_needs_revision_stale',
    'correction_reason_required',
    'central_needs_correction_plan_mismatch',
    'plan_revision_still_in_review',
    'central_needs_lifecycle_state_ambiguous',
  ])('surfaces %s as its stable code and never retries', async (code) => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: code } });
    await expect(service.openCorrectionRevision('org-1', 2025, 'rev-1', 'x'))
      .rejects.toMatchObject({ name: 'CentralNeedsError', code });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('C2 — openPlanRevision is the annual draft only', () => {
  it('always sends p_open_next_revision = false', async () => {
    rpc.mockResolvedValue({
      data: { ok: true, plan_revision_id: 'rev-1', revision_number: 1, status: 'draft', idempotent_replay: false },
      error: null,
    });
    await service.openPlanRevision('org-1', 2027);
    await service.openPlanRevision('org-1', 2027, false);
    for (const call of rpc.mock.calls) {
      expect(call[0]).toBe('phoenix_central_needs_open_plan_revision');
      expect(call[1]).toEqual({ p_organization_id: 'org-1', p_plan_year: 2027, p_open_next_revision: false });
    }
  });

  it('surfaces the server refusal of the legacy correction path', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'central_needs_governed_correction_required' } });
    await expect(service.openPlanRevision('org-1', 2027))
      .rejects.toMatchObject({ code: 'central_needs_governed_correction_required' });
  });
});

describe('C2 — fetchRevisionLifecycle', () => {
  it('reads one plan year and maps its lineage', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true, organization_id: 'org-1', plan_id: 'plan-1', plan_year: 2025, effective_revision_id: 'rev-1',
        revisions: [],
        events: [{
          action: 'central_needs.plan_revision.open_correction', revision_id: 'rev-2', revision_number: 2,
          occurred_at: '2026-09-22T07:00:00Z', actor_id: 'user-1', actor_role: 'central_warehouse_manager',
          from_status: null, to_status: null, reason: 'recount',
          opened_after_revision_id: 'rev-1', effective_approved_revision_id: 'rev-1',
          predecessor_revision_id: null, superseded_by_revision_id: null,
        }],
      },
      error: null,
    });
    const h = await service.fetchRevisionLifecycle('org-1', 2025);
    expect(rpc).toHaveBeenCalledWith('phoenix_central_needs_revision_lifecycle', { p_organization_id: 'org-1', p_plan_year: 2025 });
    expect(h).toMatchObject({ planId: 'plan-1', planYear: 2025, effectiveRevisionId: 'rev-1' });
    expect(h.events).toEqual([{
      action: 'open_correction', revisionId: 'rev-2', revisionNumber: 2, occurredAt: '2026-09-22T07:00:00Z',
      actorId: 'user-1', actorRole: 'central_warehouse_manager', fromStatus: null, toStatus: null, reason: 'recount',
      openedAfterRevisionId: 'rev-1', effectiveApprovedRevisionId: 'rev-1',
      predecessorRevisionId: null, supersededByRevisionId: null,
    }]);
  });
});
