/**
 * CANONICAL-STOCK-CUTOVER — outlet_stock correction contract (migration 086).
 *
 * The ONE deliberate quantity-write affordance on the outlet surface is a
 * physical-count CORRECTION. These static source assertions prove it:
 *   - routes through the guarded canonical RPC phoenix_count_outlet_stock_guarded,
 *     never item_availability, never a direct table write;
 *   - carries an expected generation (optimistic concurrency) and a stable,
 *     retry-safe idempotency token;
 *   - is gated, in the UI, on the SCOPED outlet_stock.count permission (the same
 *     question the RPC re-answers server-side) — never a raw role name;
 *   - is bilingual.
 * Matches this repo's established static-scan test convention (no live DB).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const OUTLET = join(__dirname, '..');
const SRC = join(__dirname, '../../..');
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');

const service = read(OUTLET, 'outlet-stock.service.ts');
const modal = read(OUTLET, 'OutletStockCorrectionModal.tsx');
const screen = read(OUTLET, 'OutletOperationsScreen.tsx');
const permHook = read(SRC, 'features/inventory/useOutletCountPermission.ts');
const strings = read(SRC, 'shared/i18n/strings.ts');

describe('A) correctOutletStock maps to the guarded canonical RPC with exact params', () => {
  // 098 SECOND-PERSON-CORRECTION-APPROVAL: the real correction entry point is
  // the REQUEST RPC, not the bare guarded RPC it delegates to internally for
  // within-threshold variances (086's own RPC is still called, just not from
  // React directly — see 098's own SQL for that delegation).
  it('calls phoenix_request_outlet_stock_correction (098), not the raw 067/086 or a table write', () => {
    expect(service).toContain("supabase.rpc('phoenix_request_outlet_stock_correction'");
    expect(service).not.toMatch(/\.from\([^)]*\)\.(insert|update|upsert|delete)/);
    expect(service).not.toMatch(/service_role|auth\.admin/);
  });

  it('forwards request id, outlet lot, counted quantity, reason, expected generation, notes', () => {
    const start = service.indexOf('export async function correctOutletStock');
    const body = service.slice(start, service.indexOf('\n}', start));
    for (const p of [
      'p_request_id',
      'p_outlet_stock_id',
      'p_counted_quantity',
      'p_reason',
      'p_expected_generation',
      'p_notes',
    ]) {
      expect(body, p).toContain(p);
    }
    expect(body).toContain('input.expectedGeneration');
  });

  it('exposes the server-owned generation on the read row (movement_seq → generation)', () => {
    expect(service).toContain('movement_seq');
    expect(service).toMatch(/generation:\s*typeof r\.movement_seq/);
  });
});

describe('B) error classification distinguishes the concurrency conflict from validation', () => {
  const start = service.indexOf('export function classifyOutletCorrectionError');
  const body = service.slice(start, service.indexOf('\n}', start));
  const cases: Array<[string, string]> = [
    ['40001', 'outlet_correct_generation_conflict'],
    ['outlet_stock_generation_conflict', 'outlet_correct_generation_conflict'],
    ['outlet_quantity_below_reserved', 'outlet_correct_below_reserved'],
    ['counted_quantity_must_be_non_negative', 'outlet_correct_negative'],
    ['outlet_count_reason_required', 'outlet_correct_reason_required'],
    ['request_id_conflict', 'outlet_correct_request_conflict'],
  ];
  for (const [needle, key] of cases) {
    it(`${needle} → ${key}`, () => {
      expect(body).toContain(needle);
      expect(body).toContain(key);
    });
  }
  it('42501/forbidden → outlet_correct_forbidden', () => {
    expect(body).toMatch(/42501|forbidden/);
    expect(body).toContain('outlet_correct_forbidden');
  });
});

describe('C) the modal is a thin, retry-safe client over the guarded RPC', () => {
  it('submits through the service wrapper, never a raw rpc/table call', () => {
    expect(modal).toContain('correctOutletStock(');
    expect(modal).not.toContain('supabase.rpc(');
    expect(modal).not.toMatch(/\.from\(/);
  });

  it('sends the lot last-read generation as expectedGeneration', () => {
    expect(modal).toMatch(/expectedGeneration:\s*lot!?\.generation/);
  });

  it('reuses one idempotency token across a lost-response retry, clearing it on conflict', () => {
    expect(modal).toContain('requestIdRef');
    expect(modal).toContain('crypto.randomUUID()');
    // On a generation/request conflict the token is discarded so the next
    // attempt is a fresh operation against a reloaded generation.
    expect(modal).toMatch(/generation_conflict'\s*\|\|\s*key === 'outlet_correct_request_conflict'/);
  });

  it('will not submit without the canCorrect gate, an integer >= 0 count, and a reason', () => {
    expect(modal).toMatch(/canSubmit\s*=\s*canCorrect/);
    expect(modal).toContain('countedNum >= 0');
    expect(modal).toContain('!reasonMissing');
  });
});

describe('D) the UI gate matches the RPC scope — outlet_stock.count, never a role name', () => {
  it('the permission hook asks the scoped outlet_stock.count question for this outlet', () => {
    expect(permHook).toContain("permissionKey: 'outlet_stock.count'");
    expect(permHook).toContain('distributionPointId');
    expect(permHook).not.toMatch(/role === 'point_operator'|role === 'outlet/);
  });

  it('the Stock tab only offers Correct when canCorrect, and mounts the guarded modal', () => {
    const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('useOutletCountPermission(');
    expect(code).toContain('canCorrect &&');
    expect(code).toContain('<OutletStockCorrectionModal');
    // reloads canonical server truth after a correction
    expect(code).toContain('stock.reload()');
  });

  it('adds no direct balance-write token to the screen (the RPC is the boundary)', () => {
    const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['set_exact', '.insert(', '.update(', '.upsert(', 'applyAvailabilityMovement', 'upsertAvailability']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

describe('E) every new correction string is bilingual', () => {
  for (const key of [
    'oc_correct_action', 'oc_correct_title', 'oc_correct_desc', 'oc_counted_label',
    'oc_counted_err', 'oc_reason_label', 'oc_reason_required', 'oc_notes_label',
    'oc_submit', 'oc_cancel', 'oc_no_permission',
    'outlet_correct_generation_conflict', 'outlet_correct_below_reserved',
    'outlet_correct_negative', 'outlet_correct_reason_required',
    'outlet_correct_request_conflict', 'outlet_correct_forbidden',
  ]) {
    it(`${key} defines ar and en`, () => {
      const line = strings.split('\n').find(l => l.trimStart().startsWith(`${key}:`));
      expect(line, key).toBeTruthy();
      expect(line, `${key} ar`).toMatch(/ar:\s*'[^']+'/);
      expect(line, `${key} en`).toMatch(/en:\s*'[^']+'/);
    });
  }
});
