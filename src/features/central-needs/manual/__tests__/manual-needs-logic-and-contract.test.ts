/**
 * R1-A4 — pure logic + service contract of the manual annual-needs workspace.
 * The contract half reads the R1-a SQL candidate itself, so a renamed parameter fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkManualQuantityText, proposeAsciiDigits } from '../manual-quantity';
import { foldManualEvents, canEditManual } from '../manual-needs.view-model';
import { MANUAL_COPY_KEYS, mt, quantityReasonText } from '../manual-needs.i18n';
import type { ManualNeedEvent } from '../manual-needs.service';

const rpc = vi.fn();
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
const svc = await import('../manual-needs.service');

beforeEach(() => rpc.mockReset());

describe('manual quantity grammar (mirrors the database CHECK)', () => {
  it.each(['0', '1', '10', '12.5', '0.25', '1000000', '3.14159'])('accepts %s', (q) => {
    expect(checkManualQuantityText(q)).toEqual({ ok: true, text: q });
  });
  it.each([
    ['', 'empty'], ['٣', 'non_ascii_digits'], ['1٫5', 'non_ascii_digits'], ['۱۲', 'non_ascii_digits'], ['1،000', 'not_canonical'],
    ['01', 'not_canonical'], ['1.50', 'not_canonical'], ['1.', 'not_canonical'], ['.5', 'not_canonical'], ['-1', 'not_canonical'],
    ['+1', 'not_canonical'], [' 1', 'not_canonical'], ['1 ', 'not_canonical'], ['1e3', 'not_canonical'], ['1,000', 'not_canonical'],
    ['NaN', 'not_canonical'], ['0.0', 'not_canonical'], ['00', 'not_canonical'],
  ])('refuses %j as %s', (q, reason) => {
    expect(checkManualQuantityText(q)).toEqual({ ok: false, reason });
  });
  it('refuses non-strings and over-long text', () => {
    expect(checkManualQuantityText(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(checkManualQuantityText(5)).toEqual({ ok: false, reason: 'empty' });
    expect(checkManualQuantityText('1'.repeat(257))).toEqual({ ok: false, reason: 'too_long' });
    expect(checkManualQuantityText('1'.repeat(256)).ok).toBe(true);
  });
  it('proposes ASCII digits for display only, and only when the result is canonical', () => {
    expect(proposeAsciiDigits('١٢٫٥')).toBe('12.5');
    expect(proposeAsciiDigits('۱۲')).toBe('12');
    expect(proposeAsciiDigits('٠١')).toBeNull();      // would become 01
    expect(proposeAsciiDigits('12')).toBeNull();      // nothing to propose
  });
});

const ev = (o: Partial<ManualNeedEvent> & { id: string; eventSeq: number; eventKind: ManualNeedEvent['eventKind'] }): ManualNeedEvent => ({
  planRevisionId: 'rev', beneficiaryOrganizationId: 'b1', centralItemId: 'i1', targetWarehouseId: null,
  quantityText: '5', approvedUnit: 'box', reason: 'r', reference: null, actorId: 'u', ...o,
});

describe('event chain folding', () => {
  it('last event decides; a void row is not live and shows no quantity; scopes are independent', () => {
    const rows = foldManualEvents([
      ev({ id: 'e3', eventSeq: 3, eventKind: 'correct', quantityText: '9' }),
      ev({ id: 'e1', eventSeq: 1, eventKind: 'add' }),
      ev({ id: 'e2', eventSeq: 2, eventKind: 'void', quantityText: null }),
      ev({ id: 'x1', eventSeq: 1, eventKind: 'add', centralItemId: 'i2', quantityText: '2' }),
      ev({ id: 'x2', eventSeq: 2, eventKind: 'void', centralItemId: 'i2', quantityText: null }),
    ]);
    const i1 = rows.find((r) => r.centralItemId === 'i1')!;
    const i2 = rows.find((r) => r.centralItemId === 'i2')!;
    expect(i1).toMatchObject({ live: true, quantityText: '9', lastEventId: 'e3', lastSeq: 3 });
    expect(i1.history.map((h) => h.id)).toEqual(['e1', 'e2', 'e3']);
    expect(i2).toMatchObject({ live: false, quantityText: null, lastEventId: 'x2' });
  });
  it('never alters quantity text (no Number() round trip)', () => {
    const [row] = foldManualEvents([ev({ id: 'a', eventSeq: 1, eventKind: 'add', quantityText: '0.10000000000000000001' })]);
    expect(row.quantityText).toBe('0.10000000000000000001');
  });
  it('editing requires a manual DRAFT and the manual key', () => {
    expect(canEditManual({ status: 'draft', sourceMode: 'manual', manualSet: true })).toBe(true);
    for (const a of [
      { status: 'submitted', sourceMode: 'manual', manualSet: true }, { status: 'approved', sourceMode: 'manual', manualSet: true },
      { status: 'draft', sourceMode: 'excel', manualSet: true }, { status: 'draft', sourceMode: 'manual', manualSet: false },
    ]) expect(canEditManual(a)).toBe(false);
  });
});

describe('copy', () => {
  it('has Arabic and English for every key and every quantity reason', () => {
    for (const k of MANUAL_COPY_KEYS) {
      expect(mt(k, 'ar').length, k).toBeGreaterThan(0);
      expect(mt(k, 'en').length, k).toBeGreaterThan(0);
      expect(mt(k, 'ar'), k).not.toBe(mt(k, 'en'));
    }
    for (const r of ['empty', 'non_ascii_digits', 'too_long', 'not_canonical'] as const) {
      expect(quantityReasonText(r, 'ar')).not.toBe(quantityReasonText(r, 'en'));
    }
  });
});

describe('service contract — parameter names equal the SQL signatures', () => {
  const sql = readFileSync(join(__dirname, '../../../../../supabase/candidates/R1a_04_manual_routines_inert.sql'), 'utf8').replace(/\r\n/g, '\n');
  const paramsOf = (fn: string): string[] => {
    const m = sql.match(new RegExp(`CREATE FUNCTION public\\.phoenix_central_needs_${fn}\\(([\\s\\S]*?)\\)\\s*RETURNS`));
    if (!m) throw new Error(`no SQL for ${fn}`);
    return m[1].split(',').map((p) => p.trim().split(/\s+/)[0]).filter((p) => p.startsWith('p_'));
  };
  const scope = { planRevisionId: 'r', beneficiaryOrganizationId: 'b', centralItemId: 'i', targetWarehouseId: null };
  const cases: Array<[string, () => Promise<unknown>, unknown]> = [
    ['open_manual_plan_revision', () => svc.openManualPlanRevision('o', 2030), { plan_revision_id: 'x', revision_number: 1 }],
    ['open_manual_correction_revision', () => svc.openManualCorrectionRevision('o', 2030, 'e', 'why'), { plan_revision_id: 'x', revision_number: 2 }],
    ['carry_forward_manual_lines', () => svc.carryForwardManualLines('r', 's'), { carried_count: 1 }],
    ['add_manual_need_line', () => svc.addManualNeedLine(scope, '5', 'why', 'key-12345678', null), {}],
    ['correct_manual_need_line', () => svc.correctManualNeedLine(scope, '5', 'why', 'key-12345678', 'e'), {}],
    ['void_manual_need_line', () => svc.voidManualNeedLine(scope, 'why', 'key-12345678', 'e'), {}],
    ['withdraw_draft_revision', () => svc.withdrawDraftRevision('r', 'e', 'why'), { withdrawal_id: 'w' }],
    ['acknowledge_manual_coverage', () => svc.acknowledgeManualCoverage('r', 'a'.repeat(64), 'why'), { acknowledgement_id: 'a' }],
  ];
  it.each(cases)('%s sends exactly the SQL parameter names', async (fn, call, data) => {
    rpc.mockResolvedValueOnce({ data, error: null });
    await call();
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe(`phoenix_central_needs_${fn}`);
    expect(Object.keys(args).sort()).toEqual(paramsOf(fn).sort());
  });
  it('readers send the SQL parameter names too', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await svc.listManualNeedEvents('r');
    expect(Object.keys((rpc.mock.calls[0] as [string, object])[1])).toEqual(['p_plan_revision_id']);
    rpc.mockResolvedValueOnce({ data: [{ view: true, manual_set: true }], error: null });
    const caps = await svc.getManualCapabilities('o', null);
    expect(caps).toMatchObject({ view: true, manualSet: true, edit: false });
    expect(Object.keys((rpc.mock.calls[1] as [string, object])[1]).sort()).toEqual(['p_organization_id', 'p_plan_revision_id']);
  });
  it('an invalid quantity never reaches the network', async () => {
    for (const q of ['١٢', '1.50', '', '01']) {
      await expect(svc.addManualNeedLine(scope, q, 'why', 'key-12345678', null)).rejects.toThrow(/manual_quantity_/);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a server refusal surfaces the database identifier, unflattened', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'manual_need_line_stale', code: '23514', details: 'last=abc', hint: null } });
    await expect(svc.addManualNeedLine(scope, '5', 'why', 'key-12345678', null)).rejects.toMatchObject({ businessCode: 'manual_need_line_stale' });
  });
  it('the module contains no direct table access', () => {
    const src = readFileSync(join(__dirname, '../manual-needs.service.ts'), 'utf8');
    expect(src).not.toMatch(/\.from\(/);
    expect(src).not.toMatch(/\.(insert|update|delete|upsert)\(/);
  });
});
