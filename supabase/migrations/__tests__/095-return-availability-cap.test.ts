/**
 * RETURN-AVAILABILITY-CAP-095 — static SQL contract tests.
 * Dynamic proof (real over-cap attempts against a live rig) is in
 * 095-return-availability-cap.dynamic.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '095_phoenix_return_availability_cap.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

describe('registration and discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only and a single transaction', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('institution->central return line (069) gains a current-availability cap', () => {
  const fn = code.slice(
    code.indexOf('FUNCTION public.phoenix_add_warehouse_return_request_line'),
    code.indexOf('FUNCTION public.phoenix_add_outlet_return_request_line'),
  );
  it('locks the canonical source warehouse_stock row FOR UPDATE', () => {
    expect(fn).toMatch(/FROM public\.warehouse_stock s\s+WHERE s\.id = v_orig\.resulting_warehouse_stock_id[\s\S]*?FOR UPDATE/);
  });
  it('caps by on_hand - reserved, in addition to the historical received/returned cap', () => {
    expect(fn).toMatch(/v_available\s*:=\s*COALESCE\(v_stock\.on_hand_quantity, 0\) - COALESCE\(v_stock\.reserved_quantity, 0\)/);
    expect(fn).toMatch(/requested_quantity_exceeds_returnable['"]?\s*USING ERRCODE = '23514'/);
    expect(fn).toMatch(/requested_quantity_exceeds_current_availability/);
  });
});

describe('outlet->institution return line (071) gains a current-availability cap', () => {
  const fn = code.slice(code.indexOf('FUNCTION public.phoenix_add_outlet_return_request_line'));
  it('locks outlet_stock FOR UPDATE (upgraded from a plain read)', () => {
    expect(fn).toMatch(/FROM public\.outlet_stock WHERE id = v_dispatch\.resulting_outlet_stock_id FOR UPDATE/);
  });
  it('caps by on_hand - reserved, in addition to the historical dispatch-line cap', () => {
    expect(fn).toMatch(/v_available\s*:=\s*COALESCE\(v_stock\.on_hand_quantity, 0\) - COALESCE\(v_stock\.reserved_quantity, 0\)/);
    expect(fn).toMatch(/requested_quantity_exceeds_returnable_cap/);
    expect(fn).toMatch(/requested_quantity_exceeds_current_availability/);
  });
  it('preserves the provenance material/batch/expiry mismatch guard verbatim', () => {
    expect(fn).toMatch(/provenance_material_batch_expiry_mismatch/);
  });
});

describe('no privilege was widened', () => {
  it('both functions keep their original scoped-permission checks', () => {
    expect(code).toMatch(/'warehouse_transfer\.return_request'/);
    expect(code).toMatch(/'outlet_stock\.return_request'/);
  });
});
