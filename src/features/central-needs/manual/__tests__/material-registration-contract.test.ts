/**
 * R1-A2/A4 — contract tests that need no browser: the client service sends exactly the SQL parameter names (read from the
 * candidate itself), the copy is complete in both languages, and no service writes a table directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOURNEY_COPY_KEYS, jt, journeyErrorText } from '../manual-journey.i18n';

const rpc = vi.fn();
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: vi.fn() } }));
const svc = await import('../material-registration.service');

beforeEach(() => rpc.mockReset());

const sql = readFileSync(join(__dirname, '../../../../../supabase/candidates/R1a_06_material_registration_inert.sql'), 'utf8').replace(/\r\n/g, '\n');
const paramsOf = (fn: string): string[] => {
  const m = sql.match(new RegExp(`CREATE FUNCTION public\\.phoenix_central_needs_${fn}\\(([\\s\\S]*?)\\)\\s*RETURNS`));
  if (!m) throw new Error(`no SQL for ${fn}`);
  return m[1].split(',').map((p) => p.trim().split(/\s+/)[0]).filter((p) => p.startsWith('p_'));
};
const D = { scientificName: 'Zolpidem', nameAr: null, tradeName: null, strength: '10 mg', dosageForm: 'Tablet', unit: 'box' as const, barcode: null, note: null };

describe('service contract — parameter names equal the SQL signatures', () => {
  const cases: Array<[string, () => Promise<unknown>, unknown]> = [
    ['create_material_request_draft', () => svc.createMaterialRequestDraft('o', D, 'key-12345678', { kind: 'manual_typed' }), { request_id: 'r', status: 'draft', version: 1 }],
    ['create_material_request_draft', () => svc.createMaterialRequestDraft('o', D, 'key-12345678', { kind: 'excel_assist', pointer: { sheet_index: 0, row: 3, column: 1, file_hash: 'a'.repeat(64) } }, 'rev'), { request_id: 'r', status: 'draft', version: 1 }],
    ['update_material_request_draft', () => svc.updateMaterialRequestDraft('r', 1, D), { request_id: 'r', status: 'draft', version: 2 }],
    ['submit_material_request', () => svc.submitMaterialRequest('r', 1), { request_id: 'r', status: 'submitted', version: 2 }],
    ['start_material_review', () => svc.startMaterialReview('r', 1), { request_id: 'r', status: 'under_review', version: 2 }],
    ['request_material_info', () => svc.requestMaterialInfo('r', 1, 'why'), { request_id: 'r', status: 'needs_info', version: 2 }],
    ['resolve_material_existing', () => svc.resolveMaterialExisting('r', 1, 'i', 'n'), { request_id: 'r', status: 'resolved_existing', version: 2 }],
    ['approve_new_material', () => svc.approveNewMaterial('r', 1, ['c1'], 'n'), { request_id: 'r', status: 'approved_new', version: 2 }],
    ['reject_material_request', () => svc.rejectMaterialRequest('r', 1, 'why'), { request_id: 'r', status: 'rejected', version: 2 }],
    ['cancel_material_request', () => svc.cancelMaterialRequest('r', 1, 'why'), { request_id: 'r', status: 'cancelled', version: 2 }],
    ['link_material_request_to_draft', () => svc.linkMaterialRequestToDraft('r', 'rev'), { link_id: 'l', central_item_id: 'i' }],
  ];
  it.each(cases)('%s sends exactly the SQL parameter names', async (fn, call, data) => {
    rpc.mockResolvedValueOnce({ data, error: null });
    await call();
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe(`phoenix_central_needs_${fn}`);
    expect(Object.keys(args).sort()).toEqual(paramsOf(fn).sort());
  });

  it('readers send the SQL parameter names and map snake_case rows', async () => {
    rpc.mockResolvedValueOnce({ data: [{ id: 'r1', organization_id: 'o', requester_id: 'u', status: 'draft', version: 1, scientific_name: 'X', unit: 'box', provenance_kind: 'manual_typed', created_at: 't' }], error: null });
    const [row] = await svc.listMaterialRequests('o');
    expect(row).toMatchObject({ id: 'r1', scientificName: 'X', status: 'draft', provenanceKind: 'manual_typed' });
    expect(Object.keys((rpc.mock.calls[0] as [string, object])[1])).toEqual(paramsOf('list_material_requests'));
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await svc.listMaterialRequestEvents('r1');
    expect(Object.keys((rpc.mock.calls[1] as [string, object])[1])).toEqual(paramsOf('list_material_request_events'));
    rpc.mockResolvedValueOnce({ data: [{ central_item_id: 'i', grade: 'strong', score: '1', name: 'N', unit: 'box', status: 'active' }], error: null });
    expect((await svc.listMaterialRequestCandidates('r1'))[0]).toMatchObject({ centralItemId: 'i', grade: 'strong', score: 1 });
    expect(Object.keys((rpc.mock.calls[2] as [string, object])[1])).toEqual(paramsOf('material_request_candidates'));
    rpc.mockResolvedValueOnce({ data: [{ can_request: true, can_review: false, can_link: true }], error: null });
    expect(await svc.getMaterialCapabilities('o')).toEqual({ canRequest: true, canReview: false, canLink: true });
    expect(Object.keys((rpc.mock.calls[3] as [string, object])[1])).toEqual(paramsOf('my_material_capabilities'));
  });

  it('a manual_typed request carries an empty provenance; an excel_assist request carries the identity-only pointer and nothing else', async () => {
    rpc.mockResolvedValueOnce({ data: { request_id: 'r' }, error: null });
    await svc.createMaterialRequestDraft('o', D, 'key-12345678', { kind: 'manual_typed' });
    expect((rpc.mock.calls[0] as [string, Record<string, unknown>])[1].p_provenance).toEqual({});
    rpc.mockResolvedValueOnce({ data: { request_id: 'r' }, error: null });
    await svc.createMaterialRequestDraft('o', D, 'key-12345678', { kind: 'excel_assist', pointer: { sheet_index: 0, row: 3, column: 1, file_hash: 'a'.repeat(64) } });
    expect(Object.keys((rpc.mock.calls[1] as [string, Record<string, unknown>])[1].p_provenance as object).sort()).toEqual(['column', 'file_hash', 'row', 'sheet_index']);
  });

  it('a server refusal surfaces the database identifier, unflattened', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'material_duplicate_strong_match', code: '23505', details: 'strong_matches=1', hint: null } });
    await expect(svc.approveNewMaterial('r', 1, [], 'n')).rejects.toMatchObject({ businessCode: 'material_duplicate_strong_match' });
  });

  it('the services contain no direct table write and the registration service no table access at all', () => {
    for (const f of ['material-registration.service.ts', 'manual-needs.service.ts', 'manual-journey.service.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(src, f).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    }
    expect(readFileSync(join(__dirname, '../material-registration.service.ts'), 'utf8')).not.toMatch(/\.from\(/);
    // the journey service reads two RLS-governed tables and nothing else
    const j = readFileSync(join(__dirname, '../manual-journey.service.ts'), 'utf8');
    expect([...j.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]).sort()).toEqual(['central_needs_plan_revisions', 'central_needs_plans']);
  });
});

describe('copy', () => {
  it('has Arabic and English for every key, and the two differ', () => {
    for (const k of JOURNEY_COPY_KEYS) {
      expect(jt(k, 'ar').length, k).toBeGreaterThan(0);
      expect(jt(k, 'en').length, k).toBeGreaterThan(0);
      expect(jt(k, 'ar'), k).not.toBe(jt(k, 'en'));
    }
  });
  it('every refusal introduced by A2 has a specific message; an unknown code degrades to its identifier, never to a generic text', () => {
    const codes = ['material_request_stale', 'material_duplicate_strong_match', 'material_duplicate_review_required', 'material_request_duplicate_open',
      'material_resolution_must_match_strong', 'material_resolution_item_not_active', 'material_request_not_assigned_reviewer', 'material_request_requester_only',
      'central_needs_separation_of_duties_violation', 'manual_intake_not_activated', 'forbidden_central_needs', 'material_link_revision_ineligible', 'material_request_not_resolved', 'material_duplicate_review_too_large'];
    for (const c of codes) {
      expect(journeyErrorText(c, 'en'), c).not.toBe(c);
      expect(journeyErrorText(c, 'ar'), c).not.toBe(journeyErrorText(c, 'en'));
    }
    expect(journeyErrorText('some_future_code', 'en')).toBe('some_future_code');
  });
  it('every database code the A2 SQL can raise for a person is either translated or left to the generic identifier path (inventory)', () => {
    const raised = new Set([...sql.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map((m) => m[1]));
    const untranslated = [...raised].filter((c) => journeyErrorText(c, 'en') === c).sort();
    // These are developer-facing guards (precondition / argument shape / transaction mode); a person only meets them through a bug.
    for (const c of untranslated) expect(c, c).toMatch(/precondition|requires_read_committed|arguments_required|identity_immutable|version_must_advance|invalid_transition|terminal_immutable|descriptor_frozen|material_provenance_invalid|material_unit_required|material_idempotency_key_invalid|material_context_revision_ineligible|material_request_not_found|not_authenticated|material_note_required|material_reason_required|material_request_not_(editable|submittable|reviewable|cancellable)|idempotency_conflict|material_request_not_assigned/);
  });
});
