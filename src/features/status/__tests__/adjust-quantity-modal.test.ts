/**
 * AVAILABILITY-QUANTITY-MOVEMENT-UI-A
 *
 * Verifies the Status Center "Adjust Quantity" row action + modal:
 *  - The action is permission-gated on the four quantity-movement keys.
 *  - Movement type options are filtered to only the permissions the caller holds.
 *  - Amount/reason validation matches the RPC's own rules (client-side UX
 *    only — the RPC re-enforces all of this server-side).
 *  - Submit calls applyAvailabilityMovement with the right params.
 *  - Success shows before/after and triggers a Status Center reload.
 *  - Known error classifications map to friendly messages.
 *  - Guards: no migrations/RPC/QR files touched, no service_role, no Excel
 *    import introduced, EditorScreen unchanged in this phase.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const modal        = readSrc('features/status/AdjustQuantityModal.tsx');
const editorScreen  = readSrc('features/editor/EditorScreen.tsx');
const strings      = readSrc('shared/i18n/strings.ts');

// ============================================================================
// 1-2. Adjust Quantity button visibility
// ============================================================================

describe('Adjust Quantity button visibility is permission-gated', () => {
  it('StatusCenterScreen derives canAdjustQuantity from the 4 quantity-movement permission keys', () => {
    expect(statusCenter).toContain('QUANTITY_MOVEMENT_PERMISSION_KEYS');
    expect(statusCenter).toContain('canAdjustQuantity');
    expect(statusCenter).toMatch(/QUANTITY_MOVEMENT_PERMISSION_KEYS\.some\(key => myPermissions\.has\(key\)\)/);
  });

  it('AdjustQuantityModal exports QUANTITY_MOVEMENT_PERMISSION_KEYS covering all 4 keys', () => {
    expect(modal).toContain('export const QUANTITY_MOVEMENT_PERMISSION_KEYS');
    ['availability.quantity.set', 'availability.quantity.add', 'availability.quantity.subtract', 'availability.quantity.correct']
      .forEach(key => expect(modal).toContain(key));
  });

  it('the action column/button only renders when canAdjustQuantity is true', () => {
    expect(statusCenter).toMatch(/\{canAdjustQuantity && </);
  });

  it('button uses the sc_adjust_qty label (bilingual)', () => {
    expect(statusCenter).toContain("t('sc_adjust_qty', lang)");
    expect(strings).toMatch(/sc_adjust_qty:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });
});

// ============================================================================
// 3. Movement type options are permission-filtered
// ============================================================================

describe('Movement type options are permission-filtered', () => {
  it('MOVEMENT_OPTIONS maps each mode to its exact permission key', () => {
    expect(modal).toContain("{ value: 'set_exact',  permKey: 'availability.quantity.set'");
    expect(modal).toContain("{ value: 'add',        permKey: 'availability.quantity.add'");
    expect(modal).toContain("{ value: 'subtract',   permKey: 'availability.quantity.subtract'");
    expect(modal).toContain("{ value: 'correction', permKey: 'availability.quantity.correct'");
  });

  it('availableOptions filters MOVEMENT_OPTIONS by myPermissions.has(permKey)', () => {
    expect(modal).toContain('MOVEMENT_OPTIONS.filter(o => myPermissions.has(o.permKey))');
  });

  it('set_exact requires availability.quantity.set specifically (not availability.quantity.add)', () => {
    const optLine = modal.split('\n').find(l => l.includes("value: 'set_exact'"));
    expect(optLine).toContain('availability.quantity.set');
    expect(optLine).not.toContain('availability.quantity.add');
  });

  it('the <select> only renders options from availableOptions (already permission-filtered)', () => {
    expect(modal).toContain('{availableOptions.map(o =>');
  });
});

// ============================================================================
// 4. Validation
// ============================================================================

describe('Amount/reason validation matches RPC rules', () => {
  it('add/subtract require amount > 0 (amountInvalid uses <= 0 for isPositiveOnly)', () => {
    expect(modal).toContain("isPositiveOnly = selectedType === 'add' || selectedType === 'subtract'");
    expect(modal).toContain('(isPositiveOnly ? amountNum <= 0 : amountNum < 0)');
  });

  it('set_exact/correction allow amount >= 0 (only < 0 is invalid)', () => {
    // Same expression above: the else-branch (non-positive-only) uses `< 0`,
    // meaning 0 is valid for set_exact/correction.
    expect(modal).toContain('amountNum < 0)');
  });

  it('correction requires a non-empty reason', () => {
    expect(modal).toContain("isCorrection = selectedType === 'correction'");
    expect(modal).toContain('reasonMissing = isCorrection && !reason.trim()');
  });

  it('correction allows amount 0 (no amount floor beyond the shared >= 0 rule)', () => {
    // isCorrection does not add any additional amount constraint beyond the
    // shared set_exact/correction `>= 0` branch already asserted above.
    expect(modal).not.toMatch(/isCorrection[\s\S]{0,80}amountNum\s*[<>]=?\s*[1-9]/);
  });

  it('subtract preview blocks submit when it would go negative', () => {
    expect(modal).toContain('previewNegative = previewAfter !== null && previewAfter < 0');
    expect(modal).toContain('!previewNegative');
    expect(modal).toContain('canSubmit');
  });

  it('canSubmit requires a selected type, valid amount, no reason error, and no negative preview', () => {
    const canSubmitBlock = modal.slice(modal.indexOf('const canSubmit ='), modal.indexOf('async function handleSubmit'));
    expect(canSubmitBlock).toContain('!!selectedType');
    expect(canSubmitBlock).toContain('!amountInvalid');
    expect(canSubmitBlock).toContain('!reasonMissing');
    expect(canSubmitBlock).toContain('!previewNegative');
    expect(canSubmitBlock).toContain('!busy');
  });
});

// ============================================================================
// 5. Submit calls applyAvailabilityMovement with the right params
// ============================================================================

describe('Submit calls applyAvailabilityMovement with the correct params', () => {
  it('imports applyAvailabilityMovement from availability.service', () => {
    expect(modal).toContain("import {\n  applyAvailabilityMovement,");
    expect(modal).toContain("from '@/shared/supabase/services/availability.service'");
  });

  it('passes itemAvailabilityId, movementType, amount, reason, notes', () => {
    const submitBlock = modal.slice(modal.indexOf('async function handleSubmit'), modal.indexOf('const fieldStyle'));
    expect(submitBlock).toContain('itemAvailabilityId: row!.id');
    expect(submitBlock).toContain('movementType: selectedType');
    expect(submitBlock).toContain('amount: amountNum');
    expect(submitBlock).toContain("reason: reason.trim() || undefined");
    expect(submitBlock).toContain("notes: notes.trim() || undefined");
  });

  it('does not call the RPC directly (goes through the service wrapper only)', () => {
    // The RPC name is legitimately mentioned once in the top-of-file doc
    // comment explaining what applyAvailabilityMovement wraps — assert there
    // is no actual supabase.rpc(...) call bypassing the wrapper.
    expect(modal).not.toContain('supabase.rpc(');
    expect(modal).not.toMatch(/from '@\/shared\/supabase\/client'/);
  });
});

// ============================================================================
// 6. Success: shows before/after, refreshes Status Center, closes modal
// ============================================================================

describe('Success behavior: preview, refresh, and close', () => {
  it('StatusCenterScreen.handleMovementSuccess shows quantityBefore -> quantityAfter in a toast', () => {
    const fnBlock = statusCenter.slice(statusCenter.indexOf('function handleMovementSuccess'), statusCenter.indexOf('const btnStyle'));
    expect(fnBlock).toContain('result.quantityBefore');
    expect(fnBlock).toContain('result.quantityAfter');
    expect(fnBlock).toContain('setMovementToast');
  });

  it('handleMovementSuccess calls live.reload() to refresh Status Center data', () => {
    const fnBlock = statusCenter.slice(statusCenter.indexOf('function handleMovementSuccess'), statusCenter.indexOf('const btnStyle'));
    expect(fnBlock).toContain('live.reload()');
  });

  it('modal onSuccess calls resetAndClose (closes the modal) after invoking onSuccess', () => {
    const submitBlock = modal.slice(modal.indexOf('async function handleSubmit'), modal.indexOf('const fieldStyle'));
    expect(submitBlock).toContain('onSuccess(result)');
    expect(submitBlock).toContain('resetAndClose()');
  });

  it('AdjustQuantityModal is wired with onSuccess={handleMovementSuccess}', () => {
    expect(statusCenter).toContain('onSuccess={handleMovementSuccess}');
  });
});

// ============================================================================
// 7. Error handling
// ============================================================================

describe('Error handling: known classifications map to friendly bilingual messages', () => {
  it('modal classifies errors via classifyAvailabilityMovementError', () => {
    expect(modal).toContain('classifyAvailabilityMovementError(e)');
    expect(modal).toContain("setError(t(classifyAvailabilityMovementError(e), lang))");
  });

  it('all 8 movement error keys have bilingual strings', () => {
    [
      'avail_movement_not_found', 'avail_movement_negative', 'avail_movement_reason_required',
      'avail_movement_no_set_permission', 'avail_movement_no_add_permission',
      'avail_movement_no_subtract_permission', 'avail_movement_no_correct_permission',
    ].forEach(key => {
      expect(strings).toMatch(new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'\\s*\\}`));
    });
    // forbidden_cross_org maps to the pre-existing avail_cross_org_denied key.
    expect(strings).toMatch(/avail_cross_org_denied:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('errors are displayed with role="alert" and do not silently pass', () => {
    expect(modal).toContain('role="alert"');
    expect(modal).toContain('{error && (');
  });

  it('a failed submit does not close the modal or clear the form (error stays visible)', () => {
    const submitBlock = modal.slice(modal.indexOf('async function handleSubmit'), modal.indexOf('const fieldStyle'));
    const catchBlock = submitBlock.slice(submitBlock.indexOf('} catch'));
    expect(catchBlock).not.toContain('resetAndClose()');
    expect(catchBlock).not.toContain('onClose()');
  });
});

// ============================================================================
// Accessibility
// ============================================================================

describe('Accessibility', () => {
  it('modal has a title via PhoenixDialog', () => {
    expect(modal).toContain("title={t('sc_adjust_qty_title', lang)}");
  });

  it('cancel/submit buttons have clear text labels', () => {
    expect(modal).toContain("t('mvmt_cancel', lang)");
    expect(modal).toContain("t('mvmt_submit', lang)");
  });

  it('loading state disables submit and cancel to prevent duplicate submit', () => {
    expect(modal).toContain('loading={busy}');
    expect(modal).toMatch(/disabled=\{!canSubmit\}/);
    expect(modal).toMatch(/onClick=\{resetAndClose\} disabled=\{busy\}/);
  });

  it('cancel (resetAndClose) does not call applyAvailabilityMovement', () => {
    expect(modal).toMatch(/function resetAndClose\(\) \{[\s\S]*?\n  \}/);
    const resetFn = modal.slice(modal.indexOf('function resetAndClose'), modal.indexOf('if (!open || !row) return null;'));
    expect(resetFn).not.toContain('applyAvailabilityMovement');
  });

  it('resetAndClose is a no-op while busy (guards against closing mid-submit)', () => {
    expect(modal).toContain('if (busy) return;');
  });
});

// ============================================================================
// Guard: no migrations/RPC/QR touched, no service_role, no Excel import,
// EditorScreen unchanged
// ============================================================================

describe('Guards for this UI-only phase', () => {
  it('does not reference service_role or auth.admin anywhere in the new files', () => {
    [modal, statusCenter].forEach(src => {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toMatch(/auth\.admin/);
    });
  });

  it('does not introduce Excel import (no xlsx/exceljs/read-excel-file usage)', () => {
    [modal, statusCenter].forEach(src => {
      expect(src).not.toMatch(/xlsx|exceljs|read-excel-file|import.*excel/i);
    });
  });

  it('EditorScreen.tsx is unchanged in this phase (no movement wiring introduced)', () => {
    expect(editorScreen).not.toContain('applyAvailabilityMovement');
    expect(editorScreen).not.toContain('AdjustQuantityModal');
    expect(editorScreen).not.toContain('phoenix_apply_availability_movement');
  });

  it('migrations 001-034 are not referenced/modified by this phase (no new migration file)', () => {
    // This phase adds no migration; the RPC/table already exist from 033/034.
    expect(modal).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+POLICY|CREATE\s+TABLE/i);
    expect(statusCenter).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+POLICY|CREATE\s+TABLE/i);
  });

  it('migration 034 (phoenix_apply_availability_movement) is untouched by this phase', () => {
    const migration034 = readPhoenix('supabase/migrations/034_phoenix_apply_availability_movement_rpc.sql');
    expect(migration034).toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
  });

  it('QR files are not referenced by the new UI', () => {
    [modal, statusCenter].forEach(src => {
      expect(src).not.toMatch(/qr_tokens|qr_targets|get_public_qr_payload|QrScreen|PublicQrScreen/);
    });
  });
});
