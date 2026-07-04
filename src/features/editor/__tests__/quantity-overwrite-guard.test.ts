/**
 * EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A
 * Run: npm test -- --run
 *
 * Static source-code tests: EditorScreen must not allow a silent quantity
 * overwrite for an already-existing item_availability row. Quantity changes
 * for existing rows must go through Status Center -> Adjust Quantity
 * (applyAvailabilityMovement / phoenix_apply_availability_movement, migration 034).
 *
 * Frontend-only guard: EditorScreen has no built-in concept of "editing an
 * existing row" (no id state, no create/update toggle, no prior fetch of a
 * single row). This phase adds client-side detection by fetching the
 * point's existing rows (getAvailabilityByPoint, already used elsewhere) and
 * matching on the exact same key as the DB partial unique index (migration
 * 029) and the phoenix_upsert_availability RPC's UPDATE lookup (migration 030):
 * distribution_point_id + scientific_name + COALESCE(concentration,'') +
 * COALESCE(dosage_form,'').
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

const editor = readSrc('features/editor/EditorScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A: existing-row detection', () => {
  it('imports getAvailabilityByPoint to detect existing rows for the selected point', () => {
    expect(editor).toContain('getAvailabilityByPoint');
  });

  it('computes an existingRow / isEditMode match using scientific_name + concentration + dosage_form', () => {
    expect(editor).toContain('existingRow');
    expect(editor).toContain('isEditMode');
    expect(editor).toMatch(/r\.scientific_name/);
    expect(editor).toMatch(/r\.concentration/);
    expect(editor).toMatch(/r\.dosage_form/);
  });

  it('does not introduce a new RPC, migration, or movement call (frontend-only guard)', () => {
    expect(editor).not.toContain('applyAvailabilityMovement');
    expect(editor).not.toContain('phoenix_apply_availability_movement');
    expect(editor).not.toContain('AvailabilityMovementType');
    expect(editor).not.toContain('AdjustQuantityModal');
  });

  it('does not use service_role', () => {
    expect(editor).not.toContain('service_role');
  });
});

describe('EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A: quantity field behavior', () => {
  it('the quantity input is disabled/read-only when isEditMode is true', () => {
    const qtyBlock = editor.slice(editor.indexOf('id="ed-qty"') - 50, editor.indexOf('id="ed-qty"') + 700);
    expect(qtyBlock).toContain('disabled={isEditMode}');
    expect(qtyBlock).toContain('readOnly={isEditMode}');
  });

  it('the quantity input displays the existing row quantity (not stale local state) in edit mode', () => {
    const qtyBlock = editor.slice(editor.indexOf('id="ed-qty"') - 50, editor.indexOf('id="ed-qty"') + 700);
    expect(qtyBlock).toMatch(/value=\{isEditMode \? existingRow!\.quantity : qty\}/);
  });

  it('the quantity field remains editable (not disabled) for a brand-new row', () => {
    // disabled is a boolean expression keyed off isEditMode; when isEditMode is
    // false (create/new), disabled/readOnly evaluate to false — input stays editable.
    expect(editor).toContain('disabled={isEditMode}');
    expect(editor).not.toContain('disabled={true}');
  });

  it('shows the bilingual warning/helper text only in edit mode', () => {
    const qtyBlock = editor.slice(editor.indexOf('id="ed-qty"') - 50, editor.indexOf('id="ed-qty"') + 1200);
    expect(qtyBlock).toContain('isEditMode && (');
    expect(qtyBlock).toContain('avail_qty_locked_note');
  });

  it('the quantity field is not removed from the DOM in edit mode (still visible)', () => {
    expect(editor).toContain('<input\n');
    expect(editor).toContain('id="ed-qty"');
  });
});

describe('EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A: save never sends a changed quantity for existing rows', () => {
  it('doApply sends existingRow quantity (not local qty state) when isEditMode is true', () => {
    const applyFn = editor.slice(editor.indexOf('async function doApply'), editor.indexOf('async function doApply') + 2000);
    expect(applyFn).toMatch(/quantity:\s*isEditMode \? existingRow!\.quantity : qty/);
  });

  it('save still sends the locally-typed qty for brand-new rows', () => {
    const applyFn = editor.slice(editor.indexOf('async function doApply'), editor.indexOf('async function doApply') + 2000);
    expect(applyFn).toContain(': qty,');
  });
});

describe('EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A: i18n helper text', () => {
  it('avail_qty_locked_note exists with Arabic and English text', () => {
    expect(strings).toMatch(/avail_qty_locked_note:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('English text matches the required message', () => {
    const line = strings.split('\n').find(l => l.includes('avail_qty_locked_note'));
    expect(line).toContain('Use Status Center');
    expect(line).toContain('Adjust Quantity');
  });

  it('Arabic text matches the required message', () => {
    const line = strings.split('\n').find(l => l.includes('avail_qty_locked_note'));
    expect(line).toContain('مركز المواقف');
    expect(line).toContain('تعديل الكمية');
  });
});

describe('EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A: no out-of-scope changes', () => {
  it('does not modify StatusCenterScreen or AdjustQuantityModal', () => {
    const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
    expect(statusCenter).not.toContain('EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A');
  });

  it('does not reference any Excel import feature', () => {
    expect(editor).not.toMatch(/xlsx|excel.?import/i);
  });

  it('does not add or reference a QR-related import', () => {
    expect(editor).not.toMatch(/qr[_-]?token|QrToken|public.?qr/i);
  });
});
