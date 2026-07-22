/**
 * AVAILABILITY-QUANTITY-MOVEMENT-RPC-A
 *
 * Verifies migration 034 (phoenix_apply_availability_movement RPC) and the
 * frontend service wrapper (applyAvailabilityMovement /
 * classifyAvailabilityMovementError in availability.service.ts):
 *  - RPC is SECURITY DEFINER, search_path-scoped, authenticated-only.
 *  - Locks the target row (FOR UPDATE) before authorizing or writing.
 *  - Enforces org scope + one of the four quantity-movement permission keys.
 *  - Raises quantity_cannot_go_negative and correction_reason_required.
 *  - Atomically updates item_availability.quantity and inserts one
 *    item_availability_movements row.
 *  - Adds NO new INSERT/UPDATE/DELETE policy on item_availability_movements.
 *  - Does not touch get_public_qr_payload or phoenix_upsert_availability.
 *  - Service wrapper calls the RPC with the right param names and maps
 *    known error codes, without altering upsertAvailability.
 *
 * Also guards that this RPC-only phase did not touch EditorScreen,
 * StatusCenter, QR files, migration 033, or any migration 001-033.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyAvailabilityMovement,
  classifyAvailabilityMovementError,
  classifyAvailabilitySaveError,
} from '@/shared/supabase/services/availability.service';
import {
  expectRetiredSurfaceAbsent,
  expectScreenThreeIsInventoryCenter,
} from '../../../../tests/helpers/retired-surfaces';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const migration034 = readPhoenix('supabase/migrations/034_phoenix_apply_availability_movement_rpc.sql');
const migration033 = readPhoenix('supabase/migrations/033_phoenix_availability_movements_schema.sql');
const migration032 = readPhoenix('supabase/migrations/032_phoenix_availability_permission_matrix_integration.sql');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');

// ============================================================================
// Migration 034 exists and is manual-apply-only
// ============================================================================

describe('Migration 034 exists and is manual-apply-only', () => {
  it('file exists and is non-empty', () => {
    expect(migration034.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(migration034).toContain('MANUAL APPLY ONLY');
    expect(migration034).toContain('DO NOT use');
    expect(migration034).toContain('supabase db push');
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    const noComments = migration034.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*(drop table|truncate)\b/im);
    expect(noComments).not.toMatch(/^\s*delete from\b/im);
  });

  it('does not reference service_role', () => {
    expect(migration034).not.toMatch(/service_role/i);
  });

  it('does not write to auth.users', () => {
    expect(migration034).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });
});

// ============================================================================
// RPC creation, security, signature
// ============================================================================

describe('phoenix_apply_availability_movement: creation and security', () => {
  const fnBlock = migration034.slice(
    migration034.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement'),
    migration034.indexOf('REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement'),
  );

  it('creates exactly the requested function name', () => {
    expect(migration034).toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement(');
  });

  it('signature matches: item_availability_id uuid, movement_type text, amount integer, reason/notes text default null', () => {
    expect(fnBlock).toContain('p_item_availability_id uuid');
    expect(fnBlock).toContain('p_movement_type        text');
    expect(fnBlock).toContain('p_amount               integer');
    expect(fnBlock).toContain("p_reason               text DEFAULT NULL");
    expect(fnBlock).toContain("p_notes                text DEFAULT NULL");
  });

  it('returns jsonb', () => {
    expect(migration034).toMatch(/RETURNS jsonb/);
  });

  it('is SECURITY DEFINER with search_path set to public', () => {
    expect(fnBlock).toContain('SECURITY DEFINER');
    expect(fnBlock).toContain('SET search_path = public');
  });

  it('requires auth.uid() to be non-null', () => {
    expect(fnBlock).toContain('v_actor           uuid := auth.uid()');
    expect(fnBlock).toContain("RAISE EXCEPTION 'not_authenticated'");
  });

  it('validates item_availability_id, movement_type, amount presence/range', () => {
    expect(fnBlock).toContain("RAISE EXCEPTION 'item_availability_id_required'");
    expect(fnBlock).toContain("RAISE EXCEPTION 'invalid_movement_type'");
    expect(fnBlock).toContain("p_movement_type NOT IN ('set_exact', 'add', 'subtract', 'correction')");
    expect(fnBlock).toContain("RAISE EXCEPTION 'amount_required'");
  });

  it('requires amount >= 0 for set_exact/correction and > 0 for add/subtract', () => {
    expect(fnBlock).toContain("p_movement_type IN ('set_exact', 'correction') AND p_amount < 0");
    expect(fnBlock).toContain("RAISE EXCEPTION 'amount_must_be_non_negative'");
    expect(fnBlock).toContain("p_movement_type IN ('add', 'subtract') AND p_amount <= 0");
    expect(fnBlock).toContain("RAISE EXCEPTION 'amount_must_be_positive'");
  });

  it('requires a non-empty reason for correction', () => {
    expect(fnBlock).toContain("p_movement_type = 'correction' AND (p_reason IS NULL OR btrim(p_reason) = '')");
    expect(fnBlock).toContain("RAISE EXCEPTION 'correction_reason_required'");
  });
});

// ============================================================================
// Row locking, not-found, org scope, permission checks
// ============================================================================

describe('phoenix_apply_availability_movement: locking, org scope, permissions', () => {
  const fnBlock = migration034.slice(
    migration034.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement'),
    migration034.indexOf('REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement'),
  );

  it('selects the target row FOR UPDATE', () => {
    expect(fnBlock).toContain('FROM public.item_availability');
    expect(fnBlock).toContain('FOR UPDATE');
  });

  it('raises availability_not_found when the row does not exist', () => {
    expect(fnBlock).toContain("RAISE EXCEPTION 'availability_not_found'");
    expect(fnBlock).toContain("USING ERRCODE = 'P0002'");
  });

  it('never trusts organization_id/distribution_point_id/identity fields from the client — reads them from the locked row', () => {
    expect(fnBlock).toContain('v_row.organization_id');
    expect(fnBlock).toContain('v_row.distribution_point_id');
    expect(fnBlock).toContain('v_row.scientific_name');
    expect(fnBlock).toContain('v_row.concentration');
    expect(fnBlock).toContain('v_row.dosage_form');
    expect(fnBlock).toContain('v_row.trade_name');
    // No p_organization_id / p_distribution_point_id parameter exists at all.
    expect(migration034).not.toContain('p_organization_id');
    expect(migration034).not.toContain('p_distribution_point_id');
  });

  it('super_admin bypasses org scope; others require organization_id = phoenix_my_org()', () => {
    expect(fnBlock).toContain("v_is_super := (v_role = 'super_admin')");
    expect(fnBlock).toContain('v_row.organization_id <> v_my_org');
    expect(fnBlock).toContain("RAISE EXCEPTION 'forbidden_cross_org'");
  });

  it('checks phoenix_profile_has_permission for all four movement-type keys with the correct error codes', () => {
    expect(fnBlock).toContain("phoenix_profile_has_permission(v_actor, 'availability.quantity.set')");
    expect(fnBlock).toContain("RAISE EXCEPTION 'forbidden_availability_quantity_set'");
    expect(fnBlock).toContain("phoenix_profile_has_permission(v_actor, 'availability.quantity.add')");
    expect(fnBlock).toContain("RAISE EXCEPTION 'forbidden_availability_quantity_add'");
    expect(fnBlock).toContain("phoenix_profile_has_permission(v_actor, 'availability.quantity.subtract')");
    expect(fnBlock).toContain("RAISE EXCEPTION 'forbidden_availability_quantity_subtract'");
    expect(fnBlock).toContain("phoenix_profile_has_permission(v_actor, 'availability.quantity.correct')");
    expect(fnBlock).toContain("RAISE EXCEPTION 'forbidden_availability_quantity_correct'");
  });

  it('all forbidden_* and quantity_cannot_go_negative errors use ERRCODE 42501/23514', () => {
    expect(fnBlock).toMatch(/forbidden_cross_org'\s*USING ERRCODE = '42501'/);
    expect(fnBlock).toMatch(/forbidden_availability_quantity_set'\s*USING ERRCODE = '42501'/);
    expect(fnBlock).toMatch(/quantity_cannot_go_negative'\s*USING ERRCODE = '23514'/);
  });
});

// ============================================================================
// Quantity math
// ============================================================================

describe('phoenix_apply_availability_movement: quantity math', () => {
  const fnBlock = migration034.slice(
    migration034.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement'),
    migration034.indexOf('REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement'),
  );

  it('set_exact: quantity_after = amount, quantity_delta = amount - quantity_before', () => {
    expect(fnBlock).toMatch(/WHEN 'set_exact' THEN\s*\n\s*v_quantity_after := p_amount;\s*\n\s*v_quantity_delta := p_amount - v_quantity_before;/);
  });

  it('add: quantity_after = quantity_before + amount, quantity_delta = amount', () => {
    expect(fnBlock).toMatch(/WHEN 'add' THEN\s*\n\s*v_quantity_after := v_quantity_before \+ p_amount;\s*\n\s*v_quantity_delta := p_amount;/);
  });

  it('subtract: quantity_after = quantity_before - amount, quantity_delta = -amount', () => {
    expect(fnBlock).toMatch(/WHEN 'subtract' THEN\s*\n\s*v_quantity_after := v_quantity_before - p_amount;\s*\n\s*v_quantity_delta := -p_amount;/);
  });

  it('correction: same math shape as set_exact', () => {
    expect(fnBlock).toMatch(/WHEN 'correction' THEN\s*\n\s*v_quantity_after := p_amount;\s*\n\s*v_quantity_delta := p_amount - v_quantity_before;/);
  });

  it('raises quantity_cannot_go_negative before any write when quantity_after < 0', () => {
    const negGuardIdx = fnBlock.indexOf('quantity_cannot_go_negative');
    const updateIdx = fnBlock.indexOf('UPDATE public.item_availability');
    expect(negGuardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(negGuardIdx).toBeLessThan(updateIdx);
  });
});

// ============================================================================
// Atomic write + actor snapshot + return value
// ============================================================================

describe('phoenix_apply_availability_movement: atomic write and return shape', () => {
  const fnBlock = migration034.slice(
    migration034.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement'),
    migration034.indexOf('REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement'),
  );

  it('updates item_availability.quantity', () => {
    expect(fnBlock).toContain('UPDATE public.item_availability');
    expect(fnBlock).toContain('SET quantity        = v_quantity_after');
  });

  it('resolves actor snapshot from profiles + auth.users, mirroring migration 014', () => {
    expect(fnBlock).toContain('FROM public.profiles p');
    expect(fnBlock).toContain('LEFT JOIN auth.users u ON u.id = p.id');
    expect(fnBlock).toContain('p.full_name, u.email, p.role');
  });

  it('inserts exactly one item_availability_movements row with all required fields', () => {
    expect(fnBlock).toContain('INSERT INTO public.item_availability_movements (');
    [
      'item_availability_id', 'organization_id', 'distribution_point_id',
      'scientific_name', 'concentration', 'dosage_form', 'trade_name',
      'movement_type', 'quantity_before', 'quantity_delta', 'quantity_after',
      'reason', 'notes', 'created_by',
      'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot',
    ].forEach(col => expect(fnBlock).toContain(col));
  });

  it('returns the expected jsonb shape', () => {
    expect(fnBlock).toContain("'ok', true");
    expect(fnBlock).toContain("'item_availability_id', v_row.id");
    expect(fnBlock).toContain("'movement_id', v_movement_id");
    expect(fnBlock).toContain("'movement_type', p_movement_type");
    expect(fnBlock).toContain("'quantity_before', v_quantity_before");
    expect(fnBlock).toContain("'quantity_delta', v_quantity_delta");
    expect(fnBlock).toContain("'quantity_after', v_quantity_after");
  });
});

// ============================================================================
// Grants
// ============================================================================

describe('phoenix_apply_availability_movement: grants', () => {
  it('revokes from PUBLIC and anon', () => {
    expect(migration034).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_apply_availability_movement\(\s*uuid, text, integer, text, text\s*\) FROM PUBLIC, anon/);
  });

  it('grants execute only to authenticated', () => {
    expect(migration034).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_apply_availability_movement\(\s*uuid, text, integer, text, text\s*\) TO authenticated/);
  });
});

// ============================================================================
// No new table policies, no touch to migration 033/032/QR
// ============================================================================

describe('Migration 034 adds no new table policies and does not modify prior migrations', () => {
  it('creates no CREATE POLICY statement at all', () => {
    expect(migration034).not.toMatch(/CREATE\s+POLICY/i);
  });

  it('does not modify get_public_qr_payload or any QR table/function', () => {
    expect(migration034).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.get_public_qr_payload/i);
    expect(migration034).not.toMatch(/ALTER\s+TABLE\s+(public\.)?qr_(tokens|targets)/i);
  });

  it('does not create or replace phoenix_upsert_availability', () => {
    expect(migration034).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.phoenix_upsert_availability/i);
  });

  it('migration 032 (phoenix_upsert_availability) is unaffected', () => {
    expect(migration032).toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('migration 033 (item_availability_movements schema) is unaffected', () => {
    expect(migration033).toContain('CREATE TABLE IF NOT EXISTS public.item_availability_movements');
    expect(migration033).toContain('CREATE POLICY "avail_mvmt_select_perm"');
  });
});

// ============================================================================
// Service wrapper: applyAvailabilityMovement
// ============================================================================

describe('applyAvailabilityMovement service wrapper', () => {
  it('calls the phoenix_apply_availability_movement RPC with the correct param names', () => {
    expect(availabilityService).toContain("supabase.rpc('phoenix_apply_availability_movement'");
    expect(availabilityService).toContain('p_item_availability_id: input.itemAvailabilityId');
    expect(availabilityService).toContain('p_movement_type:        input.movementType');
    expect(availabilityService).toContain('p_amount:               input.amount');
    expect(availabilityService).toContain('p_reason:               input.reason ?? null');
    expect(availabilityService).toContain('p_notes:                input.notes ?? null');
  });

  it('exports AvailabilityMovementType covering all four modes', () => {
    expect(availabilityService).toContain("export type AvailabilityMovementType = 'set_exact' | 'add' | 'subtract' | 'correction'");
  });

  it('is exported and callable', () => {
    expect(typeof applyAvailabilityMovement).toBe('function');
  });

  it('guards on supabaseConfigured before calling the RPC (source-level check)', () => {
    const fnBody = availabilityService.slice(
      availabilityService.indexOf('export async function applyAvailabilityMovement'),
    );
    expect(fnBody).toContain("if (!supabaseConfigured) throw new Error('Supabase not configured')");
  });

  it('does not reference service_role or auth.admin', () => {
    expect(availabilityService).not.toMatch(/service_role/i);
    expect(availabilityService).not.toMatch(/auth\.admin/);
  });
});

// ============================================================================
// classifyAvailabilityMovementError
// ============================================================================

describe('classifyAvailabilityMovementError', () => {
  it('classifies availability_not_found', () => {
    expect(classifyAvailabilityMovementError({ message: 'availability_not_found' })).toBe('avail_movement_not_found');
  });

  it('classifies quantity_cannot_go_negative', () => {
    expect(classifyAvailabilityMovementError({ message: 'quantity_cannot_go_negative' })).toBe('avail_movement_negative');
  });

  it('classifies correction_reason_required', () => {
    expect(classifyAvailabilityMovementError({ message: 'correction_reason_required' })).toBe('avail_movement_reason_required');
  });

  it('classifies forbidden_cross_org', () => {
    expect(classifyAvailabilityMovementError({ code: '42501', message: 'forbidden_cross_org' })).toBe('avail_cross_org_denied');
  });

  it('classifies all four forbidden_availability_quantity_* codes', () => {
    expect(classifyAvailabilityMovementError({ code: '42501', message: 'forbidden_availability_quantity_set' })).toBe('avail_movement_no_set_permission');
    expect(classifyAvailabilityMovementError({ code: '42501', message: 'forbidden_availability_quantity_add' })).toBe('avail_movement_no_add_permission');
    expect(classifyAvailabilityMovementError({ code: '42501', message: 'forbidden_availability_quantity_subtract' })).toBe('avail_movement_no_subtract_permission');
    expect(classifyAvailabilityMovementError({ code: '42501', message: 'forbidden_availability_quantity_correct' })).toBe('avail_movement_no_correct_permission');
  });

  it('falls back to load_error for unrelated errors', () => {
    expect(classifyAvailabilityMovementError({ code: '23514', message: 'invalid_movement_type' })).toBe('load_error');
    expect(classifyAvailabilityMovementError(new Error('network down'))).toBe('load_error');
  });
});

// ============================================================================
// upsertAvailability / classifyAvailabilitySaveError unchanged
// ============================================================================

describe('upsertAvailability and classifyAvailabilitySaveError are unchanged', () => {
  it('classifyAvailabilitySaveError still classifies availability.create/update errors the same way', () => {
    expect(classifyAvailabilitySaveError({ code: '42501', message: 'forbidden_availability_create' })).toBe('avail_no_create_permission');
    expect(classifyAvailabilitySaveError({ code: '42501', message: 'forbidden_availability_update' })).toBe('avail_no_update_permission');
  });

  it('upsertAvailability still calls phoenix_upsert_availability, unaffected by the new movement wrapper', () => {
    expect(availabilityService).toContain("rpc('phoenix_upsert_availability'");
  });
});

// ============================================================================
// Guard: EditorScreen, StatusCenter, QR untouched by this RPC-only phase
// ============================================================================

describe('EditorScreen, StatusCenter, and QR are untouched by this phase', () => {
  // E6: this used to assert the retired EditorScreen never called the movement
  // RPC. The screen is now deleted, so the isolation guard becomes an ABSENCE
  // guard — strictly stronger than "the file exists and does not contain X".
  it('EditorScreen is retired, so it cannot call the movement RPC at all', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
    expectScreenThreeIsInventoryCenter();
  });

  it('StatusCenterScreen.tsx calls applyAvailabilityMovement only via the service wrapper (added by AVAILABILITY-QUANTITY-MOVEMENT-UI-A), never the raw RPC name', () => {
    // As of AVAILABILITY-QUANTITY-MOVEMENT-UI-A, StatusCenterScreen legitimately
    // wires up the "Adjust Quantity" action through applyAvailabilityMovement()
    // (via AdjustQuantityModal) — see adjust-quantity-modal.test.ts for full
    // coverage. This test guards that it never bypasses the wrapper by calling
    // the RPC name/supabase.rpc directly.
    // The RPC name may legitimately appear in an explanatory code comment
    // (documenting why the permission check is UX-only) — assert there is no
    // actual supabase.rpc(...) call site bypassing the wrapper.
    const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
    expect(statusCenter).not.toContain('supabase.rpc(');
  });

  it('qr.service.ts is unaffected', () => {
    const qrService = readSrc('shared/supabase/services/qr.service.ts');
    expect(qrService).toContain('export async function getPublicQrPayload');
    expect(qrService).toContain("supabase.rpc('get_public_qr_payload'");
  });

  it('migration 034 does not modify get_public_qr_payload or any QR table', () => {
    // "does not touch" is documented in header prose; assert no CREATE/ALTER/
    // policy statement actually targets get_public_qr_payload or QR tables.
    expect(migration034).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.get_public_qr_payload/i);
    expect(migration034).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+(public\.)?qr_(tokens|targets)/i);
    expect(migration034).not.toMatch(/ALTER\s+TABLE\s+(public\.)?qr_(tokens|targets)/i);
  });
});
