/**
 * R1-UNIT-TEST-01 — unit-vocabulary contract (client side).
 *
 * The owner's 2026 acceptance draft is a screening reagent dosed in `test`
 * units. The server enforces the unit vocabulary with three CHECK constraints
 * (central_items.unit in M001, central_needs_need_lines.approved_unit in M212,
 * central_needs_material_requests.unit in M228), and the client mirrors that
 * vocabulary in exactly two constants:
 *
 *   * MATERIAL_UNITS / MaterialUnit   (material-registration.service.ts)
 *   * NEED_LINE_UNITS / NeedLineUnit  (central-needs.service.ts)
 *
 * These tests lock the client mirror to the post-M231 nine-unit vocabulary:
 * 'test' MUST be present (append-only, last position), the historical eight
 * MUST keep their order, and both constants MUST carry the same set so the
 * registration flow and the need-line flow can never drift apart.
 *
 * The server-side half of this contract (the three CHECK constraints accept
 * 'test', reject non-vocabulary units, keep the historical eight) is enforced
 * by the dynamic migration test `231_phoenix_unit_test_vocabulary.dynamic.test.ts`
 * against a real disposable PostgreSQL — never here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/supabase/client', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
  supabaseConfigured: false,
}));

import { MATERIAL_UNITS, type MaterialUnit } from '../manual/material-registration.service';
import { NEED_LINE_UNITS, type NeedLineUnit } from '../central-needs.service';

/** Post-M231 vocabulary: the historical eight in their original order, 'test' appended. */
const EXPECTED_UNITS = ['box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other', 'test'] as const;

describe('R1-UNIT-TEST-01 — client unit vocabulary admits test', () => {
  it('MATERIAL_UNITS equals the nine-unit vocabulary in order', () => {
    expect([...MATERIAL_UNITS]).toEqual([...EXPECTED_UNITS]);
  });

  it('NEED_LINE_UNITS equals the nine-unit vocabulary in order', () => {
    expect([...NEED_LINE_UNITS]).toEqual([...EXPECTED_UNITS]);
  });

  it('both constants carry the same set (registration vs need-line cannot drift)', () => {
    expect([...MATERIAL_UNITS].sort()).toEqual([...NEED_LINE_UNITS].sort());
  });

  it("'test' is accepted by both unit types (compile-time + runtime)", () => {
    const asMaterial: MaterialUnit = 'test';
    const asNeedLine: NeedLineUnit = 'test';
    expect(MATERIAL_UNITS).toContain(asMaterial);
    expect(NEED_LINE_UNITS).toContain(asNeedLine);
  });

  it('the historical eight keep their original order at the head of the list', () => {
    expect([...MATERIAL_UNITS.slice(0, 8)]).toEqual([...EXPECTED_UNITS.slice(0, 8)]);
    expect([...NEED_LINE_UNITS.slice(0, 8)]).toEqual([...EXPECTED_UNITS.slice(0, 8)]);
  });
});
