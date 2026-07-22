/**
 * INVENTORY-CENTER-INTAKE-A
 * Run: npm test -- --run
 *
 * The Inventory Management & Intake Center replaces the Availability Editor.
 * The editor let an operator type a quantity AND hand-pick an availability
 * condition, writing item_availability through phoenix_upsert_availability —
 * a second source of stock truth competing with the warehouse ledger.
 *
 * These tests pin the invariants that make the replacement safe. They are
 * deliberately static source scans (the convention in this repo — no runtime
 * Supabase mock exists) plus pure-function assertions, so they hold without a
 * database and cannot be satisfied by a passing manual test run.
 *
 * Source text is newline-normalized before matching: a CRLF working copy on
 * Windows must not change the outcome relative to CI's LF checkout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyIntakeError,
  newRequestId,
  WAREHOUSE_ADJUSTMENT_TYPES,
} from '../warehouse-intake.service';

const SRC = join(process.cwd(), 'src');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Strip block and line comments. The "does not call X" assertions must scan
 * executable code only — a doc comment that NAMES the retired writer in order
 * to explain why it was retired is documentation, not a call, and must not
 * fail the guard (nor be deletable to make the guard pass).
 */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const screen = readSrc('features/inventory/InventoryCenterScreen.tsx');
const service = readSrc('features/inventory/warehouse-intake.service.ts');
const permsHook = readSrc('features/inventory/useWarehouseStockPermissions.ts');
const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');

describe('Stock truth: the warehouse ledger is the only write path', () => {
  it('the intake service writes exclusively through migration-065 RPCs', () => {
    expect(service).toContain("supabase.rpc(fn, args)");
    // Migration 078 moved the client onto the GUARDED entry points. They are not a
    // new write path: each enforces the expected-generation precondition and then
    // delegates to the very 065 RPC this invariant is about, so the ledger still
    // has exactly one implementation of the write.
    expect(service).toContain("'phoenix_receive_warehouse_stock_guarded'");
    expect(service).toContain("'phoenix_apply_warehouse_stock_movement_guarded'");
  });

  it('the intake service never writes any table directly', () => {
    expect(service).not.toMatch(/\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
  });

  it('the intake service never writes item_availability — it is a projection, not a target', () => {
    expect(service).not.toMatch(/from\('item_availability'\)/);
    expect(codeOnly(service)).not.toContain('phoenix_upsert_availability');
  });

  it('neither the screen nor the service touches warehouse_stock / outlet_stock directly', () => {
    for (const source of [screen, service]) {
      expect(source).not.toMatch(/from\('warehouse_stock'\)\s*[\s\S]{0,120}\.(insert|update|upsert|delete)\(/);
      expect(source).not.toMatch(/from\('outlet_stock'\)\s*[\s\S]{0,120}\.(insert|update|upsert|delete)\(/);
    }
  });

  it('the screen does not call the legacy independent availability writer', () => {
    expect(codeOnly(screen)).not.toContain('upsertAvailability');
    expect(codeOnly(screen)).not.toContain('phoenix_upsert_availability');
  });

  it('no service_role / admin key is referenced anywhere in the new surface', () => {
    for (const source of [screen, service, permsHook]) {
      expect(source).not.toContain('service_role');
      expect(source).not.toContain('auth.admin');
      expect(source).not.toContain('SERVICE_ROLE');
    }
  });
});

describe('No manual condition: availability is derived, never chosen', () => {
  it('the screen offers no available/low/missing/surplus dropdown', () => {
    // The four legacy AvailabilityCondition values must not appear as options.
    expect(screen).not.toMatch(/'available'/);
    expect(screen).not.toMatch(/'low_stock'/);
    expect(screen).not.toMatch(/'missing'/);
    expect(screen).not.toMatch(/'surplus'/);
    expect(screen).not.toContain('CONDITION_OPTIONS');
    expect(screen).not.toContain('AvailabilityCondition');
  });

  it('the screen states that the condition is derived from the ledger', () => {
    expect(screen).toContain("t('inv_derived_notice', lang)");
  });

  it('a projection-read-only rejection maps to its own explicit message', () => {
    expect(classifyIntakeError('warehouse_managed_availability_read_only')).toBe('inv_err_projection_read_only');
    expect(classifyIntakeError('warehouse_managed_availability_server_only')).toBe('inv_err_projection_read_only');
    expect(classifyIntakeError('availability_source_kind_immutable')).toBe('inv_err_projection_read_only');
  });
});

describe('Quantity invariants', () => {
  it('the UI never offers a "set the balance to N" mode — only real movements', () => {
    expect([...WAREHOUSE_ADJUSTMENT_TYPES]).toEqual(['add', 'subtract', 'correction']);
    expect([...WAREHOUSE_ADJUSTMENT_TYPES]).not.toContain('set_exact');
  });

  it('intake accepts only a positive integer quantity', () => {
    expect(screen).toContain('Number.isInteger(qty) && qty > 0');
  });

  it('negative-balance and below-reserved rejections are distinguishable to the operator', () => {
    expect(classifyIntakeError('warehouse_quantity_cannot_go_negative')).toBe('inv_err_negative');
    expect(classifyIntakeError('warehouse_quantity_below_reserved')).toBe('inv_err_below_reserved');
    expect(classifyIntakeError('quantity_must_be_positive')).toBe('inv_err_qty_positive');
    expect(classifyIntakeError('amount_must_be_positive')).toBe('inv_err_qty_positive');
  });

  it('a correction requires a reason before the request is sent', () => {
    expect(screen).toContain("const needsReason = movementType === 'correction' || movementType === 'set_exact'");
    expect(screen).toContain("(!needsReason || reason.trim() !== '')");
    expect(classifyIntakeError('warehouse_correction_reason_required')).toBe('inv_err_reason_required');
  });
});

describe('Retry invariant: a replayed submit cannot double-post', () => {
  it('every write carries a caller-generated idempotency key', () => {
    expect(service).toContain('p_request_id:             input.requestId');
    expect(service).toMatch(/p_request_id:\s+input\.requestId/g);
  });

  it('newRequestId produces a distinct uuid per entry', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('the intake form holds one request id across retries and mints a new one only on reset', () => {
    expect(screen).toContain('const [requestId, setRequestId] = useState(newRequestId)');
    // reset() is the ONLY place a new key is minted in the intake form.
    expect(screen).toContain('setRequestId(newRequestId());');
    const submitBlock = screen.slice(screen.indexOf('const submit = async () => {'), screen.indexOf('return (\n    <PhoenixCard>'));
    expect(submitBlock).not.toContain('setRequestId(newRequestId())');
  });

  it('a replayed receipt is reported as already-recorded, not as a fresh post', () => {
    expect(screen).toContain("result.data?.replayed ? 'inv_intake_replayed' : 'inv_intake_ok'");
  });

  it('a request id reused with different data surfaces a distinct, actionable error', () => {
    expect(classifyIntakeError('request_id_conflict')).toBe('inv_err_request_conflict');
  });
});

describe('Identity invariant: a blank field is never read as "none exists"', () => {
  it('the operator must explicitly acknowledge an absent national code / batch number', () => {
    expect(screen).toContain('hasNoNationalCode: noNationalCode');
    expect(screen).toContain('hasNoBatchNumber: noBatchNumber');
    expect(screen).toContain("(noNationalCode ? nationalCode.trim() === '' : nationalCode.trim() !== '')");
    expect(screen).toContain("(noBatchNumber ? batchNumber.trim() === '' : batchNumber.trim() !== '')");
  });

  it('the acknowledgement flags are required parameters, not optional', () => {
    expect(service).toContain('hasNoNationalCode: boolean;');
    expect(service).toContain('hasNoBatchNumber: boolean;');
  });

  it('server-side identity rejections each map to a specific message', () => {
    expect(classifyIntakeError('explicit_identity_flags_required')).toBe('inv_err_identity_flags_required');
    expect(classifyIntakeError('national_code_flag_mismatch')).toBe('inv_err_national_code_mismatch');
    expect(classifyIntakeError('batch_number_flag_mismatch')).toBe('inv_err_batch_mismatch');
    expect(classifyIntakeError('warehouse_stock_identity_resolution_failed')).toBe('inv_err_identity');
  });
});

describe('Role and scope invariants', () => {
  it('write gates resolve the SCOPED keys migration 065 actually checks', () => {
    expect(permsHook).toContain("'warehouse_stock.adjust'");
    expect(permsHook).toContain("'warehouse_stock.correct'");
  });

  it('the permission hook fails closed with no org, no warehouse, or no profile', () => {
    expect(permsHook).toContain('if (!orgId || !warehouseId || !profile?.id) return DENIED;');
    expect(permsHook).toContain('const DENIED: WarehouseStockPermissions = { canAdjust: false, canCorrect: false };');
  });

  it('the permission check is scoped per warehouse, never a blanket org grant', () => {
    expect(permsHook).toContain('warehouseId,');
    expect(permsHook).toContain('distributionPointId: null,');
  });

  it('correction is offered only to warehouse_stock.correct holders', () => {
    expect(screen).toContain("x === 'correction' ? canCorrect : canAdjust");
  });

  it('the RBAC contract is not modified — no new permission keys are registered', () => {
    const permissions = readSrc('shared/lib/permissions.ts');
    expect(permissions).not.toContain('warehouse_stock.adjust');
    expect(permissions).not.toContain('warehouse_stock.correct');
  });
});

describe('IDOR invariant: a scope id from another org cannot survive a switch', () => {
  it('the selected warehouse is re-validated against the current org catalog every render', () => {
    expect(screen).toContain('const activeWarehouseId = manageableWarehouses.some(w => w.id === warehouseId) ? warehouseId : \'\';');
  });

  it('the ledger tab re-validates its selected batch against the loaded batches', () => {
    expect(screen).toContain('const activeBatchId = batches.some(b => b.id === batchId) ? batchId : \'\';');
  });

  it('only warehouses the profile can manage are ever offered', () => {
    expect(screen).toContain('scopes.data?.manageableWarehouses ?? []');
  });

  it('a cross-org rejection is surfaced distinctly from a generic failure', () => {
    expect(classifyIntakeError('active_profile_required')).toBe('inv_err_not_authorized');
    expect(classifyIntakeError('not_authenticated')).toBe('inv_err_not_authorized');
    expect(classifyIntakeError('forbidden_warehouse_stock_adjust')).toBe('inv_err_no_receive_permission');
    expect(classifyIntakeError('forbidden_warehouse_stock_movement')).toBe('inv_err_no_movement_permission');
  });
});

describe('Route replacement', () => {
  it('screen 3 renders the Inventory Center, not the Availability Editor', () => {
    expect(authenticatedApp).toContain('case 3:  return <InventoryCenterScreen />;');
    expect(authenticatedApp).not.toContain('<EditorScreen />');
    expect(authenticatedApp).not.toContain("from '@/features/editor/EditorScreen'");
  });
});

describe('Error mapping completeness', () => {
  it('every mapped key exists in the bilingual string table', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    const tokens = [
      'forbidden_warehouse_stock_adjust', 'forbidden_warehouse_stock_movement',
      'active_profile_required', 'not_authenticated', 'explicit_identity_flags_required',
      'national_code_flag_mismatch', 'batch_number_flag_mismatch',
      'warehouse_stock_identity_resolution_failed', 'warehouse_stock_central_item_conflict',
      'request_id_conflict', 'warehouse_quantity_cannot_go_negative',
      'warehouse_quantity_below_reserved', 'quantity_must_be_positive',
      'amount_must_be_positive', 'amount_must_be_non_negative',
      'unit_price_must_be_non_negative', 'warehouse_correction_reason_required',
      'warehouse_managed_availability_read_only', 'warehouse_not_found_or_inactive',
      'warehouse_stock_not_found', 'availability_not_found',
      'invalid_warehouse_movement_type', 'request_id_required', 'unknown_token_xyz',
    ];
    for (const token of tokens) {
      const key = classifyIntakeError(token);
      expect(strings, `missing i18n key ${key} for token ${token}`).toContain(`${key}:`);
    }
  });

  it('an unrecognized token degrades to the generic message rather than leaking raw DB text', () => {
    expect(classifyIntakeError('some_unmapped_postgres_thing')).toBe('inv_err_generic');
    expect(classifyIntakeError(undefined)).toBe('inv_err_generic');
  });
});
